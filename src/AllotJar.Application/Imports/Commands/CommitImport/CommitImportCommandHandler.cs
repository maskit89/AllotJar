using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Budgets;
using AllotJar.Application.Jars;
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
    private readonly IIdentityService? _identity;

    public CommitImportCommandHandler(
        IApplicationDbContext db,
        ICurrentUser currentUser,
        IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
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

        // Transfers the user chose to confirm the other side of. Loaded tracked: matching writes
        // the statement's date and reference onto the open leg instead of inserting a row.
        var matchTargets = await LoadMatchTargetsAsync(
            request.Items.Select(i => i.MatchTransferId), userId, cancellationToken);

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
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .Where(i => wholeLineIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);
        // The departures of those lines' jars that the statement account may not hold on a row's
        // date: a row from an account the jar has left, dated while it held it there, goes on
        // the jar's line (R2-D1).
        var stretches = await JarStretches.LoadAsync(_db,
            wholeLines.Values.Where(i => i.Jar is not null && (i.Jar.FundingAccountId != request.AccountId || i.Jar.FundingAccountSince is not null))
                .Select(i => i.Jar!.Id),
            cancellationToken);
        // Every line a row names (whole or a slice) that is a jar's savings line: the jar's account
        // and the day it moved there. A payment on one the statement account didn't hold on its
        // date is written through JarMovements, which keeps it on the jar when that account held it
        // then; the reader derives only the jar's own account's payments (rule 79).
        var allLineIds = request.Items.SelectMany(BudgetItemIds).Where(id => id is not null).Select(id => id!.Value).Distinct().ToList();
        var jarHomes = await _db.BudgetItems
            .AsNoTracking()
            .Where(i => allLineIds.Contains(i.Id) && i.SavingsId != null && i.Jar != null)
            .Select(i => new { i.Id, i.Jar!.FundingAccountId, i.Jar.FundingAccountSince })
            .ToDictionaryAsync(i => i.Id, i => (i.FundingAccountId, i.FundingAccountSince), cancellationToken);
        bool DrawsFromLeftJar(CommitImportItem row) =>
            importAccount is not null
            && BudgetItemIds(row).Any(id => id is Guid lineId && jarHomes.TryGetValue(lineId, out var home)
                                            && !JarLedgerReader.HeldOn(home.FundingAccountId, home.FundingAccountSince, importAccount.Id, row.Date));

        // Idempotency: never re-create a row this STATEMENT ACCOUNT already knows (double-submit,
        // overlap, retry). The shared definition covers the leg this account's statement carries:
        // its own rows and outgoing transfers by BankReference, incoming transfers by
        // ReceiptBankReference. A bank reference reused on a DIFFERENT statement account remains
        // a genuinely distinct transaction, not a duplicate.
        var accountId = request.AccountId;
        var seen = await StatementReferences.KnownAsync(_db, userId, accountId, cancellationToken);

        int imported = 0, skipped = 0, credits = 0, debits = 0, transfers = 0, matched = 0, pendingReview = 0;
        var created = new List<Transaction>();
        var matchedIds = new HashSet<Guid>();
        var held = new List<ImportHeldRow>();

        // Rule 74/11: the statement account is evaluated row by row in date order, against its
        // stored money plus the rows accepted so far. A row that would take it below zero on any
        // date is held (reported, not posted) and the later rows are judged without it. The
        // candidate state carries the tracked match targets, since matching posts their open leg.
        var candidate = new List<Transaction>();
        if (importAccount is not null)
        {
            var storedRows = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == userId
                            && (t.AccountId == importAccount.Id
                                || (t.Type == TransactionType.Transfer && t.TransferAccountId == importAccount.Id)))
                .ToListAsync(cancellationToken);
            candidate.AddRange(storedRows.Where(t => !matchTargets.ContainsKey(t.Id)));
            candidate.AddRange(matchTargets.Values);
        }
        string? Shortfall(Transaction? tentative) =>
            importAccount is null
                ? null
                : AccountBalanceGuard.FirstShortfall(
                    new[] { importAccount },
                    tentative is null ? candidate : candidate.Append(tentative).ToList());

        var ordered = request.Items
            .Select((item, index) => (item, index))
            .OrderBy(x => x.item.Date)
            .ThenBy(x => x.index)
            .Select(x => x.item);

        foreach (var item in ordered)
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

                var reference = string.IsNullOrEmpty(item.Reference) ? null : item.Reference;

                // The user picked a recorded transfer this row is the other side of: attach this
                // statement's leg to it and apply no second balance movement (rules 8/50/51).
                if (item.MatchTransferId is Guid matchId)
                {
                    var target = ConfirmMatch(item, matchId, importAccountId, counterparty, matchTargets, matchedIds);
                    if (item.IsCredit)
                    {
                        target.ReceivedOn = item.Date;
                        target.ReceiptBankReference = reference;
                        if (item.JarAllocations is { Count: > 0 })
                        {
                            await JarMovements.ApplyIncomingAsync(
                                _db, userId, target, importAccount, item.Date, target.Amount, item.JarAllocations, "Items", cancellationToken);
                        }
                    }
                    else
                    {
                        var (previousDeparted, previousReference, previousDate) = (target.DepartedOn, target.BankReference, target.Date);
                        target.DepartedOn = item.Date;
                        target.BankReference = reference;
                        target.Date = item.Date;
                        if (Shortfall(null) is string shortfall)
                        {
                            (target.DepartedOn, target.BankReference, target.Date) = (previousDeparted, previousReference, previousDate);
                            matchedIds.Remove(matchId);
                            seen.Remove(item.Reference);
                            held.Add(new ImportHeldRow(item.Reference, shortfall));
                            continue;
                        }
                        if (item.PaidFromJarId is not null)
                        {
                            await JarMovements.ApplyOutgoingAsync(_db, userId, target, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                        }
                    }
                    matched++;
                    transfers++;
                    continue;
                }

                // A credit moved money INTO the import account (from the counterparty); a debit, OUT.
                // Each statement proves only its own bank's leg: a debit is a confirmed departure
                // (receipt unknown, money in transit — rule 71); a credit is a receipt whose
                // departure is unknown, held for review with no posted effect (rule 72).
                var (source, dest) = item.IsCredit
                    ? (counterparty, importAccountId)
                    : (importAccountId, counterparty);
                var transfer = new Transaction
                {
                    OwnerId = userId,
                    Amount = item.Amount,
                    Currency = CurrencyCode.From(item.Currency),
                    Type = TransactionType.Transfer,
                    Date = item.Date,
                    Payee = Truncate(item.Payee, 200),
                    AccountId = source,
                    TransferAccountId = dest,
                    DepartedOn = item.IsCredit ? null : item.Date,
                    ReceivedOn = item.IsCredit ? item.Date : null,
                    BankReference = item.IsCredit ? null : reference,
                    ReceiptBankReference = item.IsCredit ? reference : null,
                };
                if (!item.IsCredit && Shortfall(transfer) is string transferShortfall)
                {
                    seen.Remove(item.Reference);
                    held.Add(new ImportHeldRow(item.Reference, transferShortfall));
                    continue;
                }
                _db.Transactions.Add(transfer);
                created.Add(transfer);
                candidate.Add(transfer);
                if (item.IsCredit)
                {
                    if (item.JarAllocations is { Count: > 0 })
                    {
                        await JarMovements.ApplyIncomingAsync(
                            _db, userId, transfer, importAccount, item.Date, item.Amount, item.JarAllocations, "Items", cancellationToken);
                    }
                }
                else if (item.PaidFromJarId is not null)
                {
                    await JarMovements.ApplyOutgoingAsync(_db, userId, transfer, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                }
                imported++;
                transfers++;
                if (item.IsCredit) pendingReview++;
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
                    wholeLines[lineId], userId, type, item.Date, item.AcknowledgeCrossMonth, "Items", request.AccountId, stretches);
            }

            var transaction = new Transaction
            {
                OwnerId = userId,
                Amount = item.Amount,
                Currency = CurrencyCode.From(item.Currency),
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
                    errorKey: "Items", cancellationToken, request.AccountId);

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

            if (!item.IsCredit && Shortfall(transaction) is string rowShortfall)
            {
                seen.Remove(item.Reference);
                held.Add(new ImportHeldRow(item.Reference, rowShortfall));
                continue;
            }

            _db.Transactions.Add(transaction);
            created.Add(transaction);
            candidate.Add(transaction);

            if (importAccount is not null)
            {
                if (item.IsCredit && item.JarAllocations is { Count: > 0 })
                {
                    await JarMovements.ApplyIncomingAsync(
                        _db, userId, transaction, importAccount, item.Date, item.Amount, item.JarAllocations, "Items", cancellationToken);
                }
                else if (!item.IsCredit && (item.PaidFromJarId is not null || DrawsFromLeftJar(item)))
                {
                    await JarMovements.ApplyOutgoingAsync(_db, userId, transaction, importAccount, item.PaidFromJarId, "Items", cancellationToken);
                }
            }

            imported++;
            if (item.IsCredit) credits++; else debits++;
        }

        if (created.Count > 0 || matched > 0)
        {
            // A row in another currency waits for its budget-currency amount (rules 42/44).
            ForeignAmounts.MarkWaiting(
                created, await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken));

            // The dedup snapshot above is per-request memory; a CONCURRENT commit (double-click,
            // second device, another login in the household) can insert the same references after
            // we read it. The unique reference indexes turn that race into a DbUpdateException
            // here — recover by dropping the collided rows and saving the rest.
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    await _db.SaveChangesAsync(cancellationToken);
                    break;
                }
                catch (DbUpdateException ex) when (attempt < 3 && IsReferenceCollision(ex))
                {
                    var collided = await FindCollidedAsync(userId, created, cancellationToken);
                    if (collided.Count == 0)
                    {
                        throw; // not actually our collision — surface the real error
                    }

                    foreach (var row in collided)
                    {
                        _db.JarAllocations.RemoveRange(row.JarAllocations); // Added entities: Remove detaches them
                        _db.Transactions.Remove(row); // an Added entity: Remove detaches it
                        created.Remove(row);
                        imported--;
                        skipped++;
                        if (row.Type == TransactionType.Transfer)
                        {
                            transfers--;
                            if (row.DepartedOn is null) pendingReview--;
                        }
                        else if (row.Type == TransactionType.Income) credits--;
                        else debits--;
                    }

                    if (created.Count == 0 && matched == 0)
                    {
                        break; // everything we had was already imported by the other commit
                    }
                }
            }
        }

        return new ImportStatementResult(
            TotalEntries: request.Items.Count,
            Imported: imported,
            SkippedDuplicates: skipped,
            Credits: credits,
            Debits: debits,
            Iban: null,
            AutoCategorized: 0,
            Transfers: transfers,
            MatchedTransfers: matched,
            PendingReviewTransfers: pendingReview,
            Held: held,
            AwaitingAmount: created.Count(t => t.FxPending));
    }

    /// <summary>
    /// The user-selected transfer must genuinely be the other side of this row: same two
    /// accounts in this row's direction, same amount and currency, and its leg for the statement
    /// account still open. Anything else is a mismatch to surface, never something to guess past.
    /// </summary>
    private static Transaction ConfirmMatch(
        CommitImportItem item, Guid matchId, Guid importAccountId, Guid counterparty,
        IReadOnlyDictionary<Guid, Transaction> targets, HashSet<Guid> matchedIds)
    {
        if (!targets.TryGetValue(matchId, out var target))
        {
            throw new NotFoundException($"Transfer {matchId} was not found.");
        }
        var errors = new List<string>();
        var (expectedSource, expectedDest) = item.IsCredit
            ? (counterparty, importAccountId)
            : (importAccountId, counterparty);
        if (target.AccountId != expectedSource || target.TransferAccountId != expectedDest)
        {
            errors.Add("it moves between different accounts");
        }
        if (target.Amount != item.Amount || !string.Equals(target.Currency.Value, item.Currency, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"its amount is {target.Currency.Value} {target.Amount:0.####}, not {item.Currency} {item.Amount:0.####}");
        }
        if (!StatementReferences.IsOpenFor(target, importAccountId, item.IsCredit))
        {
            errors.Add(item.IsCredit ? "its receipt is already confirmed" : "its departure is already confirmed");
        }
        if (!matchedIds.Add(matchId))
        {
            errors.Add("another row in this import already confirms the same leg");
        }
        if (errors.Count > 0)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Items"] = new[]
                {
                    $"'{item.Payee}' can't confirm the selected transfer: {string.Join("; ", errors)}.",
                },
            });
        }
        return target;
    }

    /// <summary>
    /// True when the save failed on one of the unique statement-reference indexes. Matched by index
    /// name in the provider's message so the Application layer needs no SqlClient reference.
    /// </summary>
    private static bool IsReferenceCollision(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_AccountId_BankReference", StringComparison.Ordinal) == true
        || ex.InnerException?.Message.Contains("IX_Transactions_OwnerId_TransferAccountId_ReceiptBankReference", StringComparison.Ordinal) == true;

    /// <summary>
    /// The created rows whose statement reference another commit persisted first. Each row is
    /// checked on the leg it carries the reference on — a source/outgoing reference against
    /// its AccountId, a receipt reference against its TransferAccountId — exactly the pairs the
    /// failed insert tried.
    /// </summary>
    private async Task<List<Transaction>> FindCollidedAsync(
        string userId, IReadOnlyList<Transaction> created, CancellationToken cancellationToken)
    {
        var collided = new List<Transaction>();

        var sourceRefs = created.Where(t => t.BankReference != null).GroupBy(t => t.AccountId).ToList();
        foreach (var group in sourceRefs)
        {
            var rowAccountId = group.Key;
            var refs = group.Select(t => t.BankReference!).ToList();
            var taken = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == userId && t.AccountId == rowAccountId
                            && t.BankReference != null && refs.Contains(t.BankReference))
                .Select(t => t.BankReference!)
                .ToListAsync(cancellationToken);
            // Case-insensitive: the DB index compares with the column's CI collation, so
            // a case-variant reference blocks the insert — the recovery match must agree
            // or it would rethrow instead of skipping.
            var takenSet = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
            collided.AddRange(group.Where(t => takenSet.Contains(t.BankReference!)));
        }

        var receiptRefs = created.Where(t => t.ReceiptBankReference != null).GroupBy(t => t.TransferAccountId).ToList();
        foreach (var group in receiptRefs)
        {
            var rowAccountId = group.Key;
            var refs = group.Select(t => t.ReceiptBankReference!).ToList();
            var taken = await _db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == userId && t.TransferAccountId == rowAccountId
                            && t.ReceiptBankReference != null && refs.Contains(t.ReceiptBankReference))
                .Select(t => t.ReceiptBankReference!)
                .ToListAsync(cancellationToken);
            var takenSet = new HashSet<string>(taken, StringComparer.OrdinalIgnoreCase);
            collided.AddRange(group.Where(t => takenSet.Contains(t.ReceiptBankReference!) && !collided.Contains(t)));
        }

        return collided;
    }

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

    /// <summary>Loads the user-selected match targets, tracked, requiring each to be an owned transfer.</summary>
    private async Task<Dictionary<Guid, Transaction>> LoadMatchTargetsAsync(
        IEnumerable<Guid?> requestedIds, string userId, CancellationToken ct)
    {
        var ids = requestedIds.Where(x => x.HasValue).Select(x => x!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return new Dictionary<Guid, Transaction>();
        }
        var transfers = await _db.Transactions
            .Where(t => ids.Contains(t.Id))
            .ToListAsync(ct);
        foreach (var id in ids)
        {
            var transfer = transfers.FirstOrDefault(t => t.Id == id)
                ?? throw new NotFoundException($"Transfer {id} was not found.");
            if (transfer.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
            if (transfer.Type != TransactionType.Transfer)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Items"] = new[] { "Only a recorded transfer can be confirmed from a statement row." },
                });
            }
        }
        return transfers.ToDictionary(t => t.Id);
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
