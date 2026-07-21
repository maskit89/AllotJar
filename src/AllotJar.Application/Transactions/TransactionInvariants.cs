using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// The single place transaction-attribution invariants live, so no write path can drift.
/// Every command that attributes a transaction to a budget line — whole (CreateTransaction,
/// AssignTransaction) or sliced (SplitTransaction, split-at-creation) — routes through here.
///
/// Enforced centrally: the target line is owned by the user and its kind matches the
/// transaction's direction (income onto income lines, expense/savings onto non-income lines);
/// for a split, the slices additionally sum exactly to the parent and any per-slice member is
/// owned. (Month coherence and account-currency are added by later phases.)
///
/// Kept as a static helper taking <see cref="IApplicationDbContext"/> — the same shape as the
/// former SplitGuards it replaces — so it stays a single choke point without threading a new
/// dependency through every handler and its tests.
/// </summary>
public static class TransactionInvariants
{
    /// <summary>
    /// Validate the slices of a split — sum-to-parent, ownership, direction, member ownership —
    /// and return the loaded target lines keyed by id. Shared by SplitTransaction (post-hoc) and
    /// CreateTransaction (split at creation) so the two paths can't drift.
    /// </summary>
    public static async Task<Dictionary<Guid, BudgetItem>> ValidateSlicesAsync(
        IApplicationDbContext db,
        string userId,
        TransactionType type,
        decimal total,
        IReadOnlyList<SplitAllocationInput> allocations,
        string errorKey,
        CancellationToken cancellationToken)
    {
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
            .Where(i => itemIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);

        foreach (var id in itemIds)
        {
            if (!items.TryGetValue(id, out var item))
            {
                throw new NotFoundException($"Budget item {id} was not found.");
            }
            EnsureOwned(item, userId);

            // Keep the roll-up coherent: split an expense across expense lines,
            // income across income lines.
            if (IsIncomeLine(item) != IsIncomeTx(type))
            {
                throw Validation(errorKey, IsIncomeTx(type)
                    ? "Income can only be split across income lines."
                    : "An expense can only be split across expense lines.");
            }
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
    /// Validate a WHOLE-transaction budget-line assignment: the line is owned and its kind
    /// matches the transaction's direction, and a transfer can't carry a line. Returns the loaded
    /// line so the caller can attach it. Closes the gap where AssignTransaction/CreateTransaction
    /// checked only ownership, letting an expense land on an income line (which BudgetActuals then
    /// rolled up incoherently).
    /// </summary>
    /// <summary>
    /// The error key a cross-month assignment reports under, so the client can recognise it and
    /// offer to re-send with <c>acknowledgeCrossMonth</c> rather than showing a generic failure.
    /// </summary>
    public const string CrossMonthKey = "crossMonth";

    public static async Task<BudgetItem> ValidateWholeLineAsync(
        IApplicationDbContext db,
        string userId,
        TransactionType type,
        Guid budgetItemId,
        DateOnly transactionDate,
        bool acknowledgeCrossMonth,
        string errorKey,
        CancellationToken cancellationToken)
    {
        if (type == TransactionType.Transfer)
        {
            throw Validation(errorKey, "A transfer can't be assigned to a budget line.");
        }

        var item = await db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .FirstOrDefaultAsync(i => i.Id == budgetItemId, cancellationToken);

        if (item is null)
        {
            throw new NotFoundException($"Budget item {budgetItemId} was not found.");
        }
        EnsureOwned(item, userId);

        if (IsIncomeLine(item) != IsIncomeTx(type))
        {
            throw Validation(errorKey, IsIncomeTx(type)
                ? "Income can only be assigned to income lines."
                : "An expense can only be assigned to expense lines.");
        }

        // Month coherence: budget actuals group by the line's month, so a transaction assigned to a
        // line in a different month than its date lands on the wrong month's numbers. Reject unless
        // the caller explicitly acknowledges it (the deliberate "purchase 31 Jan, cleared 1 Feb —
        // budget it to January" case), which the client only sets after the user confirms.
        var month = item.BudgetCategory.BudgetMonth;
        if (!acknowledgeCrossMonth && (month.Year != transactionDate.Year || month.Month != transactionDate.Month))
        {
            throw Validation(CrossMonthKey,
                $"This transaction is dated {transactionDate:yyyy-MM} but that budget line is in " +
                $"{month.Year:0000}-{month.Month:00}. Confirm to budget it to {month.Year:0000}-{month.Month:00}, " +
                "or pick a line in the transaction's own month.");
        }

        return item;
    }

    private static bool IsIncomeLine(BudgetItem item) => item.BudgetCategory.Kind == CategoryKind.Income;

    private static bool IsIncomeTx(TransactionType type) => type == TransactionType.Income;

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
