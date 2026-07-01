using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets;

/// <summary>
/// Derives each budget line's <see cref="BudgetItem.ActualAmount"/> from the
/// transactions assigned to it: the sum of the assigned transactions of the
/// line's own kind (income lines roll up income transactions, expense lines roll
/// up expense transactions), in the budget's base currency via
/// Amount × ExchangeRate, plus any split slices. So an income line's "received"
/// and an expense line's "spent" both work the same way. A line with no
/// transactions reads zero. Computing at read time keeps a single, deterministic
/// source of truth that can never drift.
///
/// It also derives each fund line's rolling <see cref="BudgetItem.SavingsAvailable"/>
/// balance — the sum of every contribution (planned) minus every spend (actual)
/// for that <see cref="BudgetItem.SavingsId"/> across all months up to and including
/// the viewed one — so a sinking fund's balance carries over month to month.
/// </summary>
public static class BudgetActuals
{
    public static async Task ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        BudgetMonth month,
        CancellationToken cancellationToken)
    {
        var items = month.Categories.SelectMany(c => c.Items).ToList();
        if (items.Count == 0)
        {
            return;
        }

        // Income lines roll up income transactions; expense lines roll up expense
        // transactions. Track which ids are income so each line matches its kind.
        var incomeItemIds = month.Categories
            .Where(c => c.Kind == CategoryKind.Income)
            .SelectMany(c => c.Items)
            .Select(i => i.Id)
            .ToHashSet();

        var itemIds = items.Select(i => i.Id).ToList();

        // Whole (non-split) transactions assigned directly to a line.
        var sums = await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && t.BudgetItemId != null
                        && itemIds.Contains(t.BudgetItemId.Value))
            .GroupBy(t => new { ItemId = t.BudgetItemId!.Value, t.Type })
            .Select(g => new { g.Key.ItemId, g.Key.Type, Total = g.Sum(t => t.Amount * t.ExchangeRate) })
            .ToListAsync(cancellationToken);

        // Slices of split transactions. A split transaction has BudgetItemId == null
        // so it never appears above — no double counting. Each slice rolls up at the
        // parent's exchange rate and inherits the parent's direction (Type).
        var splitRows = await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == ownerId
                  && s.BudgetItemId != null
                  && itemIds.Contains(s.BudgetItemId.Value)
            select new { ItemId = s.BudgetItemId!.Value, t.Type, Total = s.Amount * t.ExchangeRate })
            .ToListAsync(cancellationToken);

        var splitSums = splitRows
            .GroupBy(s => new { s.ItemId, s.Type })
            .ToDictionary(g => (g.Key.ItemId, g.Key.Type), g => g.Sum(s => s.Total));

        foreach (var item in items)
        {
            var wantType = incomeItemIds.Contains(item.Id)
                ? TransactionType.Income
                : TransactionType.Expense;
            var whole = sums
                .Where(s => s.ItemId == item.Id && s.Type == wantType)
                .Sum(s => s.Total);
            var fromSplits = splitSums.TryGetValue((item.Id, wantType), out var v) ? v : 0m;
            item.ActualAmount = whole + fromSplits;
        }

        await ApplySavingsBalancesAsync(db, ownerId, month, cancellationToken);
    }

    /// <summary>
    /// Sets <see cref="BudgetItem.SavingsAvailable"/> on each of the viewed month's fund
    /// lines to the fund's running balance: every contribution (planned) minus every
    /// spend (actual) for that <see cref="BudgetItem.SavingsId"/>, across all of the
    /// user's months up to and including this one. Unspent fund money therefore rolls
    /// over instead of resetting each month.
    /// </summary>
    private static async Task ApplySavingsBalancesAsync(
        IApplicationDbContext db,
        string ownerId,
        BudgetMonth month,
        CancellationToken cancellationToken)
    {
        var savingsItems = month.Categories
            .Where(c => c.Kind == CategoryKind.Savings)
            .SelectMany(c => c.Items)
            .Where(i => i.SavingsId != null)
            .ToList();
        if (savingsItems.Count == 0)
        {
            return;
        }

        var savingsIds = savingsItems.Select(i => i.SavingsId!.Value).Distinct().ToList();

        // Every monthly instance of these funds up to and including the viewed month.
        var lines = await (
            from i in db.BudgetItems
            join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
            join m in db.BudgetMonths on c.BudgetMonthId equals m.Id
            where m.OwnerId == ownerId
                  && c.Kind == CategoryKind.Savings
                  && i.SavingsId != null
                  && savingsIds.Contains(i.SavingsId.Value)
                  && (m.Year < month.Year || (m.Year == month.Year && m.Month <= month.Month))
            select new
            {
                SavingsId = i.SavingsId!.Value,
                ItemId = i.Id,
                i.PlannedAmount,
            })
            .ToListAsync(cancellationToken);

        var lineItemIds = lines.Select(l => l.ItemId).ToList();

        // Spending tracked by transactions, per fund line (expenses only).
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

        // Net per fund: contributions (planned) minus spending (actual), all months ≤ now.
        var balanceBySavings = new Dictionary<Guid, decimal>();
        foreach (var line in lines)
        {
            var whole = txByItem.TryGetValue(line.ItemId, out var w) ? w : 0m;
            var split = splitByItem.TryGetValue(line.ItemId, out var sp) ? sp : 0m;
            var spent = whole + split;

            balanceBySavings.TryGetValue(line.SavingsId, out var running);
            balanceBySavings[line.SavingsId] = running + line.PlannedAmount - spent;
        }

        foreach (var item in savingsItems)
        {
            item.SavingsAvailable = balanceBySavings.TryGetValue(item.SavingsId!.Value, out var bal) ? bal : 0m;
        }
    }
}
