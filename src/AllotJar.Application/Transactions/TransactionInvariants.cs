using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions;

/// <summary>
/// The single place transaction-attribution invariants live, so no write path can drift.
/// Every command that attributes a transaction to a budget line — whole (CreateTransaction,
/// AssignTransaction, UpdateTransaction's retained assignment, CommitImport) or sliced
/// (SplitTransaction, split-at-creation, imported splits) — routes through here.
///
/// Enforced centrally: the target line is owned by the user and its kind matches the
/// transaction's direction (income onto income lines, expense/savings onto non-income lines);
/// a transfer can never carry a line, whole or sliced; every attribution — whole or slice —
/// is month-coherent with the transaction's date unless the caller explicitly acknowledges a
/// cross-month assignment; for a split, the slices additionally sum exactly to the parent and
/// any per-slice member is owned; and a transaction on an account must be in that account's
/// currency.
///
/// Kept as a static helper taking <see cref="IApplicationDbContext"/> — the same shape as the
/// former SplitGuards it replaces — so it stays a single choke point without threading a new
/// dependency through every handler and its tests.
/// </summary>
public static class TransactionInvariants
{
    /// <summary>
    /// The error key a cross-month assignment reports under, so the client can recognise it and
    /// offer to re-send with <c>acknowledgeCrossMonth</c> rather than showing a generic failure.
    /// </summary>
    public const string CrossMonthKey = "crossMonth";

    /// <summary>
    /// Whether a line of the given category kind may carry a transaction of the given direction:
    /// income lines take income, expense/savings lines take expenses. (A transfer matches no
    /// line at all — callers reject it before asking.) Shared with the auto-categorizer so a
    /// learned suggestion can never violate what the write paths enforce.
    /// </summary>
    public static bool LineKindMatches(CategoryKind kind, TransactionType type) =>
        (kind == CategoryKind.Income) == (type == TransactionType.Income);

    /// <summary>
    /// The direction a budget line must match for this transaction. A refund is money received
    /// (<see cref="TransactionType.Income"/>) but it follows the purchase it refunds onto an
    /// expense or savings line and never onto an income line (rules 38/39/41), so for line
    /// matching it counts as an expense. Every write path that attributes a refund asks here.
    /// </summary>
    public static TransactionType LineDirection(TransactionType type, bool isRefund) =>
        isRefund ? TransactionType.Expense : type;

    public static TransactionType LineDirection(Transaction transaction) =>
        LineDirection(transaction.Type, transaction.IsRefund);

    /// <summary>
    /// Validate the slices of a split — transfer rejection, sum-to-parent, ownership, direction,
    /// month coherence (with the acknowledge escape), member ownership — and return the loaded
    /// target lines keyed by id. Shared by SplitTransaction (post-hoc), CreateTransaction (split
    /// at creation) and CommitImport (imported splits) so the paths can't drift.
    /// </summary>
    public static async Task<Dictionary<Guid, BudgetItem>> ValidateSlicesAsync(
        IApplicationDbContext db,
        string userId,
        TransactionType type,
        decimal total,
        IReadOnlyList<SplitAllocationInput> allocations,
        DateOnly transactionDate,
        bool acknowledgeCrossMonth,
        string errorKey,
        CancellationToken cancellationToken,
        Guid? accountId = null)
    {
        // A transfer moves money between accounts and never carries budget attribution —
        // splitting one across lines would corrupt both the budget and the balances.
        if (type == TransactionType.Transfer)
        {
            throw Validation(errorKey, "A transfer can't be split across budget lines.");
        }

        // The slices must account for the whole transaction, to the cent.
        var allocated = allocations.Sum(a => a.Amount);
        if (allocated != total)
        {
            throw Validation(errorKey,
                $"The split lines must add up to {total:0.####}; they add up to {allocated:0.####}.");
        }

        // Load every target line once, owned by the user, with its kind.
        var itemIds = allocations.Select(a => a.BudgetItemId).Distinct().ToList();
        var items = await db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .Where(i => itemIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);
        var stretches = await StretchesAsync(db, items.Values, accountId, transactionDate, cancellationToken);

        foreach (var id in itemIds)
        {
            if (!items.TryGetValue(id, out var item))
            {
                throw new NotFoundException($"Budget item {id} was not found.");
            }
            EnsureOwned(item, userId);
            EnsureJarAccount(item, accountId, transactionDate, errorKey, stretches);

            // Keep the roll-up coherent: split an expense across expense lines,
            // income across income lines.
            if (!LineKindMatches(item.BudgetCategory.Kind, type))
            {
                throw Validation(errorKey, type == TransactionType.Income
                    ? "Income can only be split across income lines."
                    : "An expense can only be split across expense lines.");
            }

            // Slices follow the same month-coherence rule as a whole assignment — a slice on
            // another month's line lands on that month's actuals, so it needs the same explicit
            // acknowledgment.
            EnsureSameMonth(item, transactionDate, acknowledgeCrossMonth);
        }

        // Any per-slice member attributions must belong to this user.
        var memberIds = allocations
            .Where(a => a.MemberId is not null)
            .Select(a => a.MemberId!.Value)
            .Distinct()
            .ToList();
        if (memberIds.Count > 0)
        {
            var ownedMemberIds = await db.HouseholdMembers
                .Where(m => memberIds.Contains(m.Id) && m.OwnerId == userId)
                .Select(m => m.Id)
                .ToListAsync(cancellationToken);
            var missing = memberIds.Except(ownedMemberIds).FirstOrDefault();
            if (missing != Guid.Empty)
            {
                throw new NotFoundException($"Household member {missing} was not found.");
            }
        }

        return items;
    }

    /// <summary>
    /// Validate a WHOLE-transaction budget-line assignment: the line is owned, its kind matches
    /// the transaction's direction, a transfer can't carry a line, and the line's month matches
    /// the transaction's date (unless acknowledged). Returns the loaded line so the caller can
    /// attach it.
    /// </summary>
    public static async Task<BudgetItem> ValidateWholeLineAsync(
        IApplicationDbContext db,
        string userId,
        TransactionType type,
        Guid budgetItemId,
        DateOnly transactionDate,
        bool acknowledgeCrossMonth,
        string errorKey,
        CancellationToken cancellationToken,
        Guid? accountId = null)
    {
        var item = await db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .FirstOrDefaultAsync(i => i.Id == budgetItemId, cancellationToken);

        if (item is null)
        {
            throw new NotFoundException($"Budget item {budgetItemId} was not found.");
        }

        var stretches = await StretchesAsync(db, new[] { item }, accountId, transactionDate, cancellationToken);
        EnsureWholeLineAssignable(item, userId, type, transactionDate, acknowledgeCrossMonth, errorKey, accountId, stretches);
        return item;
    }

    /// <summary>
    /// The pure half of <see cref="ValidateWholeLineAsync"/>, for callers that batch-load their
    /// lines (CommitImport validates a whole statement in one query instead of one per row).
    /// The <paramref name="item"/> must be loaded with its category and month, and — for a jar
    /// line — its jar and that jar's account. <paramref name="stretches"/> must hold the jar's
    /// departures when the payment's account is not the one holding it on that date
    /// (<see cref="StretchesAsync"/>); null reads none.
    /// </summary>
    public static void EnsureWholeLineAssignable(
        BudgetItem item,
        string userId,
        TransactionType type,
        DateOnly transactionDate,
        bool acknowledgeCrossMonth,
        string errorKey,
        Guid? accountId = null,
        JarStretches? stretches = null)
    {
        if (type == TransactionType.Transfer)
        {
            throw Validation(errorKey, "A transfer can't be assigned to a budget line.");
        }

        EnsureOwned(item, userId);
        EnsureJarAccount(item, accountId, transactionDate, errorKey, stretches);

        if (!LineKindMatches(item.BudgetCategory.Kind, type))
        {
            throw Validation(errorKey, type == TransactionType.Income
                ? "Income can only be assigned to income lines."
                : "An expense can only be assigned to expense lines.");
        }

        EnsureSameMonth(item, transactionDate, acknowledgeCrossMonth);
    }

    /// <summary>
    /// A transaction attached to an account must be in that account's currency. Account balances
    /// sum raw amounts (no FX), so a foreign-currency transaction on an account silently corrupts
    /// its balance. We reject the mismatch (an account holds one currency; move foreign money via
    /// a transfer/import in that currency) rather than trying to convert on an account leg.
    /// </summary>
    public static void EnsureAccountCurrency(Account? account, CurrencyCode transactionCurrency, string errorKey)
    {
        if (account is not null && account.Currency != transactionCurrency)
        {
            throw Validation(errorKey,
                $"This account is in {account.Currency.Value}, but the transaction is in {transactionCurrency.Value}. " +
                $"Record it in {account.Currency.Value}, or choose an account in the transaction's currency.");
        }
    }

    /// <summary>
    /// Month coherence: budget actuals group by the line's month, so a transaction assigned to a
    /// line in a different month than its date lands on the wrong month's numbers. Reject unless
    /// the caller explicitly acknowledges it (the deliberate "purchase 31 Jan, cleared 1 Feb —
    /// budget it to January" case), which the client only sets after the user confirms.
    /// </summary>
    private static void EnsureSameMonth(BudgetItem item, DateOnly transactionDate, bool acknowledgeCrossMonth)
    {
        var month = item.BudgetCategory.BudgetMonth;
        if (!acknowledgeCrossMonth && (month.Year != transactionDate.Year || month.Month != transactionDate.Month))
        {
            throw Validation(CrossMonthKey,
                $"This transaction is dated {transactionDate:yyyy-MM} but that budget line is in " +
                $"{month.Year:0000}-{month.Month:00}. Confirm to budget it to {month.Year:0000}-{month.Month:00}, " +
                "or pick a line in the transaction's own month.");
        }
    }

    /// <summary>
    /// Rules 2/4/79: a jar's money lives in its designated account, so a payment attributed to a
    /// jar's line must leave that account — that attribution is what draws the money from the jar.
    /// A payment from nowhere, or from another account, cannot reduce the jar and is refused
    /// rather than silently counted as a plan. Nor can one dated before the day the jar moved into
    /// that account (P2-20): the ledger reads the jar as held there only from that day, so it would
    /// keep the payment on the account's unallocated money (Christopher chose to refuse it, 29
    /// September 2026). The exception is a payment from an account the jar has left, dated in a
    /// stretch the jar spent there (<paramref name="stretches"/>): that account made it while it
    /// held the jar, so it draws from the jar there and its departure is re-settled (P51; R2-D1,
    /// "Accept and settle", decided by Christopher on 29 September 2026). That covers a late entry,
    /// an existing entry re-split or re-dated within the stretch, and one moved there from another
    /// account alike.
    /// </summary>
    private static void EnsureJarAccount(
        BudgetItem item, Guid? accountId, DateOnly transactionDate, string errorKey, JarStretches? stretches)
    {
        if (item.SavingsId is null)
        {
            return;
        }
        var jar = item.Jar;
        if (jar is null)
        {
            // A dangling savings line (no jar row) cannot draw from any jar; the FK makes this
            // unreachable on SQL Server and it only occurs in tests that mint bare ids.
            return;
        }
        if (accountId is Guid paying && JarLedgerReader.HeldOn(jar.FundingAccountId, jar.FundingAccountSince, paying, transactionDate))
        {
            return;
        }
        if (accountId is Guid left && stretches?.LeftOn(jar.Id, left, transactionDate) is not null)
        {
            EnsureOpened(item, jar, left, stretches, errorKey);
            return;
        }
        var held = jar.FundingAccount?.Name ?? "its account";
        if (accountId is not null && stretches?.HeldIn(jar.Id, transactionDate) is { } then)
        {
            throw Validation(errorKey,
                $"'{item.Name}' is the jar {jar.Name}, which was held in {then} on {transactionDate:d MMM yyyy}. " +
                $"Record this payment from {then} so it comes out of the jar, or put it on another line.");
        }
        if (jar.FundingAccountSince is { } since && transactionDate < since)
        {
            throw Validation(errorKey, accountId == jar.FundingAccountId
                ? $"'{item.Name}' is the jar {jar.Name}, which moved to {held} on {since:d MMM yyyy}. " +
                  $"A payment on its line from {held} can't be dated before then. Record it on another line."
                // No account the app knows of held the jar then, so don't send the user to one.
                : $"'{item.Name}' is the jar {jar.Name}, which moved to {held} on {since:d MMM yyyy}. " +
                  "A payment dated before then can't be added to its line from any account. Record it on another line.");
        }
        throw Validation(errorKey,
            $"'{item.Name}' is the jar {jar.Name}, whose money is held in {held}. " +
            $"Record this payment from {held} so it comes out of the jar.");
    }

    /// <summary>
    /// A payment kept on a jar in an account it left is settled against that account's ledger,
    /// which reads nothing without an opening date: stored there, it would count once a date is
    /// set, but not if that date is later than the payment, while its departure's share would.
    /// </summary>
    private static void EnsureOpened(BudgetItem item, Jar jar, Guid accountId, JarStretches stretches, string errorKey)
    {
        if (stretches.OpeningDateOf(accountId) is null)
        {
            var name = stretches.NameOf(accountId) ?? "that account";
            throw Validation(errorKey,
                $"'{item.Name}' is the jar {jar.Name}, which was held in {name} then, but {name} has no opening date yet. " +
                $"Set {name}'s opening date first, or record this payment on another line.");
        }
    }

    /// <summary>
    /// The departures of the jars of <paramref name="items"/> that <paramref name="accountId"/>
    /// did not hold on <paramref name="date"/> (<see cref="JarLedgerReader.HeldOn"/>), for
    /// <see cref="EnsureWholeLineAssignable"/>; <see cref="JarStretches.None"/> when every jar
    /// line is held there (the common write costs no query) or there is no account.
    /// </summary>
    public static Task<JarStretches> StretchesAsync(
        IApplicationDbContext db, IEnumerable<BudgetItem> items, Guid? accountId, DateOnly date, CancellationToken cancellationToken)
    {
        if (accountId is not Guid paying)
        {
            return Task.FromResult(JarStretches.None);
        }
        var jarIds = items
            .Where(i => i.Jar is not null && !JarLedgerReader.HeldOn(i.Jar.FundingAccountId, i.Jar.FundingAccountSince, paying, date))
            .Select(i => i.Jar!.Id)
            .ToList();
        return jarIds.Count == 0 ? Task.FromResult(JarStretches.None) : JarStretches.LoadAsync(db, jarIds, cancellationToken);
    }

    /// <summary>
    /// A date edit that keeps the month, account and direction skips the full re-validation, but
    /// a payment from a jar's account still can't move on the jar's line to before the day the jar
    /// arrived there (P2-20, the same refusal as <see cref="EnsureWholeLineAssignable"/>), unless
    /// the new date falls in an earlier stretch the jar spent in this account (it moved away and
    /// back), whose departure governs the payment (P51). A payment from an account the jar has
    /// left is checked by <see cref="JarMovements.ApplyOutgoingAsync"/>, which refuses a date
    /// after the jar left.
    /// </summary>
    public static async Task EnsureJarLinesArrivedAsync(
        IApplicationDbContext db, IReadOnlyCollection<Guid> lineIds, Guid? accountId, DateOnly transactionDate, string errorKey,
        CancellationToken cancellationToken)
    {
        if (lineIds.Count == 0 || accountId is null)
        {
            return;
        }
        var lines = await db.BudgetItems
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .Where(i => lineIds.Contains(i.Id) && i.Jar != null && i.Jar.FundingAccountId == accountId
                        && i.Jar.FundingAccountSince != null && transactionDate < i.Jar.FundingAccountSince)
            .ToListAsync(cancellationToken);
        if (lines.Count == 0)
        {
            return;
        }
        var stretches = await JarStretches.LoadAsync(db, lines.Select(l => l.Jar!.Id), cancellationToken);
        foreach (var line in lines)
        {
            EnsureJarAccount(line, accountId, transactionDate, errorKey, stretches);
        }
    }

    private static void EnsureOwned(BudgetItem item, string userId)
    {
        if (item.BudgetCategory.BudgetMonth.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
    }

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]>
        {
            [key] = new[] { message },
        });
}
