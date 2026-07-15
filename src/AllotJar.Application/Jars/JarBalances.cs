using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// Rolls up the tracked balance of every sinking fund for a user: the sum of all
/// contributions (planned) minus all spending (actual) on the fund's lines, across
/// every month. Callers add the fund's <c>OpeningBalance</c> to get its full balance.
///
/// This is the cross-month, no-ceiling counterpart to
/// <c>BudgetActuals.ApplySavingsBalancesAsync</c> (which is scoped to a viewed month for
/// the budget grid). Spending is the fund line's assigned expense transactions and
/// split slices (at FX).
/// </summary>
public static class JarBalances
{
    /// <param name="asOf">
    /// When set, only months strictly before this (year, month) contribute — the
    /// cross-history balance as it stood entering that month. Omit for the all-time
    /// balance (the default used by the jars page and reconciliation).
    /// </param>
    public static async Task<Dictionary<Guid, decimal>> ComputeAsync(
        IApplicationDbContext db, string ownerId, CancellationToken cancellationToken,
        (int Year, int Month)? asOf = null)
    {
        var hasAsOf = asOf is not null;
        var asOfYear = asOf?.Year ?? 0;
        var asOfMonth = asOf?.Month ?? 0;

        var lines = await (
            from i in db.BudgetItems
            join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
            join m in db.BudgetMonths on c.BudgetMonthId equals m.Id
            where m.OwnerId == ownerId
                  && c.Kind == CategoryKind.Savings
                  && i.SavingsId != null
                  && (!hasAsOf
                      || m.Year < asOfYear
                      || (m.Year == asOfYear && m.Month < asOfMonth))
            select new
            {
                SavingsId = i.SavingsId!.Value,
                ItemId = i.Id,
                i.PlannedAmount,
            })
            .ToListAsync(cancellationToken);

        if (lines.Count == 0)
        {
            return new Dictionary<Guid, decimal>();
        }

        var lineItemIds = lines.Select(l => l.ItemId).ToList();

        var txByItem = (await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && t.Type == TransactionType.Expense
                        && t.BudgetItemId != null
                        && lineItemIds.Contains(t.BudgetItemId.Value))
            .GroupBy(t => t.BudgetItemId!.Value)
            .Select(g => new { ItemId = g.Key, Total = g.Sum(t => t.Amount * t.ExchangeRate) })
            .ToListAsync(cancellationToken))
            .ToDictionary(x => x.ItemId, x => x.Total);

        var splitByItem = (await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == ownerId
                  && t.Type == TransactionType.Expense
                  && s.BudgetItemId != null
                  && lineItemIds.Contains(s.BudgetItemId.Value)
            select new { ItemId = s.BudgetItemId!.Value, Total = s.Amount * t.ExchangeRate })
            .ToListAsync(cancellationToken))
            .GroupBy(x => x.ItemId)
            .ToDictionary(g => g.Key, g => g.Sum(x => x.Total));

        var balanceByJar = new Dictionary<Guid, decimal>();
        foreach (var line in lines)
        {
            var whole = txByItem.TryGetValue(line.ItemId, out var w) ? w : 0m;
            var split = splitByItem.TryGetValue(line.ItemId, out var sp) ? sp : 0m;
            var spent = whole + split;

            balanceByJar.TryGetValue(line.SavingsId, out var running);
            balanceByJar[line.SavingsId] = running + line.PlannedAmount - spent;
        }

        return balanceByJar;
    }
}
