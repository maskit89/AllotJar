using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
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
        var importAccount = await LoadOwnedAccountAsync(request.AccountId, userId, cancellationToken);
        await EnsureAllOwnedAsync(
            _db.BudgetItems.Where(i => i.BudgetCategory.BudgetMonth.OwnerId == userId),
            request.Items.SelectMany(BudgetItemIds), cancellationToken);
        await EnsureAllOwnedAsync(
            _db.HouseholdMembers.Where(m => m.OwnerId == userId),
            request.Items.SelectMany(MemberIds), cancellationToken);
        var counterpartyAccounts = await LoadOwnedAccountsAsync(
            request.Items.Select(i => i.TransferAccountId), userId, cancellationToken);

        // A transfer moves money between the import account and a counterparty, so we must know
        // which account the statement belongs to.
        if (request.AccountId is null && request.Items.Any(i => i.TransferAccountId is not null))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["AccountId"] = new[] { "Choose the account this import belongs to before marking rows as transfers." },
            });
        }

        // Whole-row assignments run through the same invariant every other write path uses
        // (direction↔kind, month coherence with the acknowledge escape) — batch-loaded here so a
        // large statement validates in one query instead of one per row. Ownership was proven
        // above; EnsureWholeLineAssignable re-checks it as defence in depth.
        var wholeLineIds = request.Items
            .Where(i => i.TransferAccountId is null && i.Splits is not { Count: > 0 })
            .Where(i => i.BudgetItemId.HasValue)
            .Select(i => i.BudgetItemId!.Value)
            .Distinct()
            .ToList();
        var wholeLines = await _db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Where(i => wholeLineIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);

        // Idempotency: never re-create a row we already have ON THIS ACCOUNT (double-submit,
        // overlap, retry). Scoped by account to match the unique index — a bank reference reused
        // on a different account is a genuinely distinct transaction, not a duplicate. Case-
        // insensitive to agree with the index's CI collation (a case-variant would otherwise pass
        // this check and then collide at the database).
        var accountId = request.AccountId;
        var existing = await _db.Transactions
            .Where(t => t.OwnerId == userId && t.AccountId == accountId && t.BankReference != null)
            .Select(t => t.BankReference!)
            .ToListAsync(cancellationToken);
        var seen = new HashSet<string>(existing, StringComparer.OrdinalIgnoreCase);

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

                // Both transfer legs move the raw amount, so — exactly like /transfer — the two
                // accounts must share a currency and the row must be in it, or the currency-blind
                // balances silently change net worth.
                var counterpartyAccount = counterpartyAccounts[counterparty];
                if (importAccount!.Currency != counterpartyAccount.Currency)
                {
                    throw new ValidationException(new Dictionary<string, string[]>
                    {
                        ["Items"] = new[]
                        {
                            $"The transfer '{item.Payee}' moves between a {importAccount.Currency.Value} and a " +
                            $"{counterpartyAccount.Currency.Value} account. Both accounts must use the same currency.",
                        },
                    });
                }
                TransactionInvariants.EnsureAccountCurrency(importAccount, CurrencyCode.From(item.Currency), "Items");

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
            var type = item.IsCredit ? TransactionType.Income : TransactionType.Expense;

            // An imported row pinned to the import account must be in that account's currency —
            // the same rule manual entry enforces (account balances sum raw amounts, no FX).
            TransactionInvariants.EnsureAccountCurrency(importAccount, CurrencyCode.From(item.Currency), "Items");

            // The whole-row assignment runs the shared invariant: direction↔kind, and month
            // coherence unless this row explicitly acknowledges budgeting to another month.
            if (!isSplit && item.BudgetItemId is Guid lineId)
            {
                TransactionInvariants.EnsureWholeLineAssignable(
                    wholeLines[lineId], userId, type, item.Date, item.AcknowledgeCrossMonth, "Items");
            }

            var transaction = new Transaction
            {
                OwnerId = userId,
                Amount = item.Amount,
                Currency = CurrencyCode.From(item.Currency),
                ExchangeRate = 1m,
                Type = type,
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
                // The same slice guard every split path uses: sum-to-parent, ownership,
                // direction, month coherence (with the acknowledge escape), member ownership.
                var slices = item.Splits!
                    .Select(s => new SplitAllocationInput(s.BudgetItemId, s.Amount, s.MemberId))
                    .ToList();
                await TransactionInvariants.ValidateSlicesAsync(
                    _db, userId, type, item.Amount, slices,
                    item.Date, item.AcknowledgeCrossMonth,
                    errorKey: "Items", cancellationToken);

                foreach (var slice in item.Splits!)
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

            // The dedup snapshot above is per-request memory; a CONCURRENT commit (double-click,
            // second device, another login in the household) can insert the same references after
            // we read it. The unique (OwnerId, AccountId, BankReference) index turns that race into
            // a DbUpdateException here — recover by dropping the collided rows and saving the rest.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    await _db.SaveChangesAsync(cancellationToken);
                    break;
                }
                catch (DbUpdateException ex) when (attempt < 3 && IsReferenceCollision(ex))
                {
                    var refs = created
                        .Where(t => t.BankReference != null)
                        .Select(t => t.BankReference!)
                        .ToList();
                    var taken = await _db.Transactions
                        .AsNoTracking()
                        .Where(t => t.OwnerId == userId && t.AccountId == accountId
                                    && t.BankReference != null && refs.Contains(t.BankReference))
                        .Select(t => t.BankReference!)
                        .ToListAsync(cancellationToken);
                    // Case-insensitive: the DB index compares with the column's CI collation, so a
                    // case-variant reference blocks the insert — the recovery match must agree or
                    // it would rethrow instead of skipping.
                    var takenSet = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);

                    var collided = created
                        .Where(t => t.BankReference is string r && takenSet.Contains(r))
                        .ToList();
                    if (collided.Count == 0)
                    {
                        throw; // not actually our collision — surface the real error
                    }

                    foreach (var row in collided)
                    {
                        _db.Transactions.Remove(row); // an Added entity: Remove detaches it
                        created.Remove(row);
                        imported--;
                        skipped++;
                        if (row.Type == TransactionType.Transfer) transfers--;
                        else if (row.Type == TransactionType.Income) credits--;
                        else debits--;
                    }

                    if (created.Count == 0)
                    {
                        break; // everything we had was already imported by the other commit
                    }
                }
            }
        }

        // Reconcile previously-pending FX rows even when this commit added nothing new — an
        // all-duplicates re-commit is the natural retry after an outage. Runs after (and
        // outside) the commit's own save so it can neither fail nor roll back the import,
        // and so the all-collided break above can't discard a reconcile.
        await FxRateResolver.ReconcilePendingAsync(_db, _exchangeRates, userId, cancellationToken);

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

    /// <summary>
    /// True when the save failed on the unique (OwnerId, AccountId, BankReference) dedup index.
    /// Matched by index name in the provider's message so the Application layer needs no SqlClient
    /// reference.
    /// </summary>
    private static bool IsReferenceCollision(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_AccountId_BankReference", StringComparison.Ordinal) == true;

    /// <summary>The import account, owned by the user — or null when no account was chosen.</summary>
    private async Task<Account?> LoadOwnedAccountAsync(Guid? accountId, string userId, CancellationToken ct)
    {
        if (accountId is not Guid id)
        {
            return null;
        }
        var account = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == id, ct)
            ?? throw new NotFoundException($"Account {id} was not found.");
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        return account;
    }

    /// <summary>
    /// Loads the requested (transfer counterparty) accounts, requiring every one to exist and be
    /// owned by the user — the entities are needed for the same-currency transfer checks.
    /// </summary>
    private async Task<Dictionary<Guid, Account>> LoadOwnedAccountsAsync(
        IEnumerable<Guid?> requestedIds, string userId, CancellationToken ct)
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, Account>();
        }
        var accounts = await _db.Accounts
            .Where(a => a.OwnerId == userId && ids.Contains(a.Id))
            .ToDictionaryAsync(a => a.Id, ct);
        if (accounts.Count != ids.Count)
        {
            throw new ForbiddenAccessException();
        }
        return accounts;
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
