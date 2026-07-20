using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// The one set of rules for split slices, shared by SplitTransaction (post-hoc split) and
/// CreateTransaction (split at creation) so the two paths can't drift: slices sum exactly to the
/// total, every target line is owned and matches the transaction's direction, and any per-slice
/// member belongs to the user. Returns the loaded target lines keyed by id.
/// </summary>
public static class SplitGuards
{
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
            if (item.BudgetCategory.BudgetMonth.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }

            // Keep the roll-up coherent: split an expense across expense lines,
            // income across income lines.
            var lineIsIncome = item.BudgetCategory.Kind == CategoryKind.Income;
            var txIsIncome = type == TransactionType.Income;
            if (lineIsIncome != txIsIncome)
            {
                throw Validation(errorKey, txIsIncome
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

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]>
        {
            [key] = new[] { message },
        });
}
