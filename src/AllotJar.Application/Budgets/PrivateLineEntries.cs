using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets;

/// <summary>
/// Deleting a budget line takes its entries off the budget (the database sets their line to
/// null). An entry from an account private to another login is on the household budget only
/// because its holder put it there, and only that login may change it (rule 31, W13), so a line
/// holding one is not deleted by anyone else: the database would change the entry out of sight
/// of the private-account guard (#277 review P3-3).
/// </summary>
public static class PrivateLineEntries
{
    public static async Task EnsureNoneAsync(
        IApplicationDbContext db, ICurrentUser currentUser, IReadOnlyCollection<Guid> lineIds, string name,
        string errorKey, CancellationToken cancellationToken)
    {
        if (lineIds.Count == 0)
        {
            return;
        }
        var viewer = currentUser.UserId;
        var othersPrivate = db.AccountPrivacies.Where(p => p.UserId != viewer).Select(p => p.AccountId);
        var held = await db.Transactions
            .IgnoreQueryFilters()
            .AnyAsync(t => t.AccountId != null
                           && othersPrivate.Contains(t.AccountId.Value)
                           && ((t.BudgetItemId != null && lineIds.Contains(t.BudgetItemId.Value))
                               || t.Splits.Any(s => s.BudgetItemId != null && lineIds.Contains(s.BudgetItemId.Value))),
                cancellationToken);
        if (held)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [errorKey] = new[]
                {
                    $"{name} holds entries from another person's private account. Only they can move those entries to another line; {name} can be deleted once they have.",
                },
            });
        }
    }
}
