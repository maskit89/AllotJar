using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Imports.Commands.CommitImport;

public class CommitImportCommandHandler : IRequestHandler<CommitImportCommand, ImportStatementResult>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IExchangeRateProvider _exchangeRates;

    public CommitImportCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IExchangeRateProvider exchangeRates)
    {
        _db = db;
        _currentUser = currentUser;
        _exchangeRates = exchangeRates;
    }

    public async Task<ImportStatementResult> Handle(CommitImportCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Validate every foreign key the caller is asking us to attach belongs to them —
        // both whole-row assignments and any per-slice split attributions.
        await EnsureAccountOwnedAsync(request.AccountId, userId, cancellationToken);
        await EnsureAllOwnedAsync(
            _db.BudgetItems.Where(i => i.BudgetCategory.BudgetMonth.OwnerId == userId),
            request.Items.SelectMany(BudgetItemIds), cancellationToken);
        await EnsureAllOwnedAsync(
            _db.HouseholdMembers.Where(m => m.OwnerId == userId),
            request.Items.SelectMany(MemberIds), cancellationToken);
        await EnsureAllOwnedAsync(
            _db.Accounts.Where(a => a.OwnerId == userId),
            request.Items.Select(i => i.TransferAccountId), cancellationToken);

        // A transfer moves money between the import account and a counterparty, so we must know
        // which account the statement belongs to.
        if (request.AccountId is null && request.Items.Any(i => i.TransferAccountId is not null))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["AccountId"] = new[] { "Choose the account this import belongs to before marking rows as transfers." },
            });
        }

        // Idempotency: never re-create a row we already have (double-submit, overlap, retry).
        var existing = await _db.Transactions
            .Where(t => t.OwnerId == userId && t.BankReference != null)
            .Select(t => t.BankReference!)
            .ToListAsync(cancellationToken);
        var seen = new HashSet<string>(existing, StringComparer.Ordinal);

        int imported = 0, skipped = 0, credits = 0, debits = 0, transfers = 0;
        var created = new List<Transaction>();

        foreach (var item in request.Items)
        {
            if (!string.IsNullOrEmpty(item.Reference) && !seen.Add(item.Reference))
            {
                skipped++;
                continue;
            }

            // Transfer rows move money between accounts — no budget line, member or split.
            if (item.TransferAccountId is Guid counterparty)
            {
                var importAccountId = request.AccountId!.Value; // guaranteed by the pre-loop check
                if (counterparty == importAccountId)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Items"] = new[]
                        {
                            $"The transfer '{item.Payee}' must move to a different account from the one being imported.",
                        },
                    });
                }
                // A credit moved money INTO the import account (from the counterparty); a debit, OUT.
                var (source, dest) = item.IsCredit
                    ? (counterparty, importAccountId)
                    : (importAccountId, counterparty);
                var transfer = new Transaction
                {
                    OwnerId = userId,
                    Amount = item.Amount,
                    Currency = CurrencyCode.From(item.Currency),
                    ExchangeRate = 1m,
                    Type = TransactionType.Transfer,
                    Date = item.Date,
                    Payee = Truncate(item.Payee, 200),
                    BankReference = string.IsNullOrEmpty(item.Reference) ? null : item.Reference,
                    AccountId = source,
                    TransferAccountId = dest,
                };
                _db.Transactions.Add(transfer);
                created.Add(transfer);
                imported++;
                transfers++;
                continue;
            }

            var isSplit = item.Splits is { Count: > 0 };

            var transaction = new Transaction
            {
                OwnerId = userId,
                Amount = item.Amount,
                Currency = CurrencyCode.From(item.Currency),
                ExchangeRate = 1m,
                Type = item.IsCredit ? TransactionType.Income : TransactionType.Expense,
                Date = item.Date,
                Payee = Truncate(item.Payee, 200),
                BankReference = string.IsNullOrEmpty(item.Reference) ? null : item.Reference,
                AccountId = request.AccountId,
                // A split transaction carries no whole-row line/member — the slices do.
                BudgetItemId = isSplit ? null : item.BudgetItemId,
                MemberId = isSplit ? null : item.MemberId,
            };

            if (isSplit)
            {
                var splits = item.Splits!;
                var allocated = splits.Sum(s => s.Amount);
                if (allocated != item.Amount)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Items"] = new[]
                        {
                            $"The split lines for '{item.Payee}' must add up to {item.Amount:0.####}; they add up to {allocated:0.####}.",
                        },
                    });
                }
                foreach (var slice in splits)
                {
                    transaction.Splits.Add(new TransactionSplit
                    {
                        BudgetItemId = slice.BudgetItemId,
                        MemberId = slice.MemberId,
                        Amount = slice.Amount,
                    });
                }
            }

            _db.Transactions.Add(transaction);
            created.Add(transaction);

            imported++;
            if (item.IsCredit) credits++; else debits++;
        }

        if (created.Count > 0)
        {
            await FxRateResolver.ApplyAsync(_db, _exchangeRates, userId, created, cancellationToken);
            await _db.SaveChangesAsync(cancellationToken);
        }

        return new ImportStatementResult(
            TotalEntries: request.Items.Count,
            Imported: imported,
            SkippedDuplicates: skipped,
            Credits: credits,
            Debits: debits,
            Iban: null,
            AutoCategorized: 0,
            Transfers: transfers);
    }

    private async Task EnsureAccountOwnedAsync(Guid? accountId, string userId, CancellationToken ct)
    {
        if (accountId is not Guid id)
        {
            return;
        }
        var account = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == id, ct)
            ?? throw new NotFoundException($"Account {id} was not found.");
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
    }

    /// <summary>
    /// Verify that every distinct, non-null id requested exists within <paramref name="ownedSource"/>
    /// (already filtered to the current user). Throws <see cref="ForbiddenAccessException"/> otherwise.
    /// </summary>
    private static async Task EnsureAllOwnedAsync<T>(
        IQueryable<T> ownedSource,
        IEnumerable<Guid?> requestedIds,
        CancellationToken ct) where T : BaseEntity
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return;
        }
        var found = await ownedSource
            .Where(e => ids.Contains(e.Id))
            .Select(e => e.Id)
            .ToListAsync(ct);
        if (found.Count != ids.Count)
        {
            throw new ForbiddenAccessException();
        }
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    /// <summary>Every budget line a row references — its whole-row assignment plus any split slices.</summary>
    private static IEnumerable<Guid?> BudgetItemIds(CommitImportItem item)
    {
        yield return item.BudgetItemId;
        if (item.Splits is not null)
        {
            foreach (var slice in item.Splits)
            {
                yield return slice.BudgetItemId;
            }
        }
    }

    /// <summary>Every member a row references — its whole-row attribution plus any split slices.</summary>
    private static IEnumerable<Guid?> MemberIds(CommitImportItem item)
    {
        yield return item.MemberId;
        if (item.Splits is not null)
        {
            foreach (var slice in item.Splits)
            {
                yield return slice.MemberId;
            }
        }
    }
}
