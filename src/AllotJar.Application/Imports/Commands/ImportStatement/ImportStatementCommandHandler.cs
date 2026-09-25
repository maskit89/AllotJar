using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Imports.Commands.ImportStatement;

public class ImportStatementCommandHandler : IRequestHandler<ImportStatementCommand, ImportStatementResult>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IReadOnlyCollection<IStatementParser> _parsers;
    private readonly IExchangeRateProvider _exchangeRates;

    public ImportStatementCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IEnumerable<IStatementParser> parsers,
        IExchangeRateProvider exchangeRates)
    {
        _db = db;
        _currentUser = currentUser;
        _parsers = parsers.ToList();
        _exchangeRates = exchangeRates;
    }

    public async Task<ImportStatementResult> Handle(ImportStatementCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Validate the target account up front (when one was chosen) so we never
        // stamp transactions onto an account that isn't the caller's.
        Account? account = null;
        if (request.AccountId is Guid accountId)
        {
            account = await _db.Accounts
                .FirstOrDefaultAsync(a => a.Id == accountId, cancellationToken);
            if (account is null)
            {
                throw new NotFoundException($"Account {accountId} was not found.");
            }
            if (account.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
        }

        var parser = _parsers.FirstOrDefault(p => p.Format == request.Format)
            ?? throw new NotFoundException($"No statement parser is registered for format '{request.Format}'.");
        var statement = parser.Parse(request.Content);

        // Every entry pinned to the account must be in its currency — the same invariant manual
        // entry and the reviewed import enforce (balances sum raw amounts, no FX). Checked over
        // the WHOLE statement before anything is created, so a bad file changes nothing.
        if (account is not null)
        {
            foreach (var entry in statement.Entries)
            {
                TransactionInvariants.EnsureAccountCurrency(
                    account, CurrencyCode.From(entry.Currency), "AccountId");
            }
        }

        // Pre-load this account's existing references so re-importing the same statement is
        // idempotent. Scoped by account (matching the unique index) so a reference a bank reuses
        // on a different account isn't mistaken for a duplicate; case-insensitive to agree with the
        // index's CI collation.
        // Shared with preview/commit so a receipt leg confirmed from this account's statement
        // counts as known here too.
        var seen = await StatementReferences.KnownAsync(_db, userId, request.AccountId, cancellationToken);

        int imported = 0, skipped = 0, credits = 0, debits = 0;
        var created = new List<Transaction>();

        foreach (var entry in statement.Entries)
        {
            // Skip an entry we have already imported (by bank reference).
            if (entry.Reference is not null && !seen.Add(entry.Reference))
            {
                skipped++;
                continue;
            }

            var transaction = new Transaction
            {
                OwnerId = userId,
                Amount = entry.Amount,
                Currency = CurrencyCode.From(entry.Currency),
                ExchangeRate = 1m, // provisional — FxRateResolver sets the real rate below
                Type = entry.IsCredit ? TransactionType.Income : TransactionType.Expense,
                Date = entry.BookingDate,
                Payee = Truncate(entry.Payee, 200),
                BankReference = entry.Reference,
                AccountId = request.AccountId,
            };
            _db.Transactions.Add(transaction);
            created.Add(transaction);

            imported++;
            if (entry.IsCredit) credits++; else debits++;
        }

        var autoCategorized = 0;
        if (created.Count > 0)
        {
            // Resolve FX rates to the budget base currency, then apply learned
            // payee -> line rules, then persist once.
            await FxRateResolver.ApplyAsync(_db, _exchangeRates, userId, created, cancellationToken);
            autoCategorized = await AutoCategorizer.ApplyAsync(_db, userId, created, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
        }

        // Reconcile previously-pending FX rows even when this import added nothing new — an
        // all-duplicates re-import is the natural retry after an outage. Runs after (and
        // outside) the import's own save so it can neither fail nor roll back the import.
        await FxRateResolver.ReconcilePendingAsync(_db, _exchangeRates, userId, cancellationToken);

        return new ImportStatementResult(
            TotalEntries: statement.Entries.Count,
            Imported: imported,
            SkippedDuplicates: skipped,
            Credits: credits,
            Debits: debits,
            Iban: statement.Iban,
            AutoCategorized: autoCategorized);
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];
}
