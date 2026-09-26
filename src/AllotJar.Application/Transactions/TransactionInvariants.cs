using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
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

        foreach (var id in itemIds)
        {
            if (!items.TryGetValue(id, out var item))
            {
                throw new NotFoundException($"Budget item {id} was not found.");
            }
            EnsureOwned(item, userId);
            EnsureJarAccount(item, accountId, errorKey);

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

        EnsureWholeLineAssignable(item, userId, type, transactionDate, acknowledgeCrossMonth, errorKey, accountId);
        return item;
    }

    /// <summary>
    /// The pure half of <see cref="ValidateWholeLineAsync"/>, for callers that batch-load their
    /// lines (CommitImport validates a whole statement in one query instead of one per row).
    /// The <paramref name="item"/> must be loaded with its category and month, and — for a jar
    /// line — its jar and that jar's account.
    /// </summary>
    public static void EnsureWholeLineAssignable(
        BudgetItem item,
        string userId,
        TransactionType type,
        DateOnly transactionDate,
        bool acknowledgeCrossMonth,
        string errorKey,
        Guid? accountId = null)
    {
        if (type == TransactionType.Transfer)
        {
            throw Validation(errorKey, "A transfer can't be assigned to a budget line.");
        }

        EnsureOwned(item, userId);
        EnsureJarAccount(item, accountId, errorKey);

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
    /// rather than silently counted as a plan.
    /// </summary>
    private static void EnsureJarAccount(BudgetItem item, Guid? accountId, string errorKey)
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
        if (accountId != jar.FundingAccountId)
        {
            var held = jar.FundingAccount?.Name ?? "its account";
            throw Validation(errorKey,
                $"'{item.Name}' is the jar {jar.Name}, whose money is held in {held}. " +
                $"Record this payment from {held} so it comes out of the jar.");
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
