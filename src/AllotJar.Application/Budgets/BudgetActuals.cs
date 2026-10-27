using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets;

/// <summary>
/// Derives each budget line's <see cref="BudgetItem.ActualAmount"/> from the
/// transactions assigned to it: the sum of the assigned transactions of the
/// line's own kind (income lines roll up income transactions, expense lines roll
/// up expense transactions), in the budget currency, plus any split slices. A row
/// still waiting for its budget-currency amount (rule 44) counts nowhere. So an income line's "received"
/// and an expense line's "spent" both work the same way. A refund (money received
/// that is linked to an earlier purchase, rules 38/39) is subtracted from the
/// expense/savings line it is assigned to — net spending in the month it was
/// received, recorded on <see cref="BudgetItem.RefundedAmount"/> so the line can
/// say so — and is never counted on an income line (rule 41). A line with no
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
    /// <param name="savingsBalances">
    /// False leaves <see cref="BudgetItem.SavingsAvailable"/> unset, for a caller that never shows
    /// it (the reports): it reads the whole jar ledger, once per month asked for.
    /// </param>
    public static Task ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        BudgetMonth month,
        CancellationToken cancellationToken,
        bool savingsBalances = true) =>
        ApplyAsync(db, ownerId, new[] { month }, cancellationToken, savingsBalances);

    /// <summary>
    /// The same for several months at once, in a fixed number of queries rather than a few per
    /// month (a year of reports): each line's sums depend only on the rows assigned to it, and
    /// each month's waiting count only on its own dates, so reading them together changes nothing.
    /// </summary>
    public static async Task ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyCollection<BudgetMonth> months,
        CancellationToken cancellationToken,
        bool savingsBalances = true)
    {
        if (months.Count == 0)
        {
            return;
        }

        // How many of each month's rows are in another currency and still wait for their
        // budget-currency amount. Those rows are EXCLUDED from every sum below — their amount is
        // not budget-currency money (rule 44). The count marks the aggregates as incomplete
        // instead of silently wrong (computed even when the month has no lines yet).
        var waiting = await FxPendingCountsAsync(db, ownerId, months.Select(m => (m.Year, m.Month)), cancellationToken);
        foreach (var month in months)
        {
            month.FxPendingCount = waiting.GetValueOrDefault((month.Year, month.Month));
        }

        var items = months.SelectMany(m => m.Categories).SelectMany(c => c.Items).ToList();
        if (items.Count == 0)
        {
            return;
        }

        // Income lines roll up income transactions; expense lines roll up expense
        // transactions. Track which ids are income so each line matches its kind.
        var incomeItemIds = months
            .SelectMany(m => m.Categories)
            .Where(c => c.Kind == CategoryKind.Income)
            .SelectMany(c => c.Items)
            .Select(i => i.Id)
            .ToHashSet();

        var itemIds = items.Select(i => i.Id).ToList();

        // Whole (non-split) transactions assigned directly to a line. Waiting rows are
        // excluded — see FxPendingCount above. Refunds are grouped apart: they are Income rows
        // that reduce an expense/savings line (rules 38/39) and never feed an income line.
        var sums = await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && !t.FxPending
                        && t.BudgetItemId != null
                        && itemIds.Contains(t.BudgetItemId.Value))
            .GroupBy(t => new { ItemId = t.BudgetItemId!.Value, t.Type, IsRefund = t.RefundOfTransactionId != null })
            .Select(g => new { g.Key.ItemId, g.Key.Type, g.Key.IsRefund, Total = g.Sum(t => t.BudgetAmount ?? t.Amount) })
            .ToListAsync(cancellationToken);
        var sumsByItem = sums.ToLookup(s => s.ItemId);

        // Slices of split transactions. A split transaction has BudgetItemId == null
        // so it never appears above — no double counting. Each slice inherits the
        // parent's direction (Type). A refund is
        // never split (RefundRules), so the filter only guards a hand-crafted row.
        var splitRows = await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == ownerId
                  && !t.FxPending
                  && t.RefundOfTransactionId == null
                  && s.BudgetItemId != null
                  && itemIds.Contains(s.BudgetItemId.Value)
            select new { ItemId = s.BudgetItemId!.Value, t.Type, Total = s.BudgetAmount ?? s.Amount })
            .ToListAsync(cancellationToken);

        var splitSums = splitRows
            .GroupBy(s => new { s.ItemId, s.Type })
            .ToDictionary(g => (g.Key.ItemId, g.Key.Type), g => g.Sum(s => s.Total));

        foreach (var item in items)
        {
            var lineSums = sumsByItem[item.Id];
            if (incomeItemIds.Contains(item.Id))
            {
                // Received income: income rows that are not refunds (rule 41), plus income slices.
                var received = lineSums
                    .Where(s => s.Type == TransactionType.Income && !s.IsRefund)
                    .Sum(s => s.Total);
                var receivedSlices = splitSums.TryGetValue((item.Id, TransactionType.Income), out var r) ? r : 0m;
                item.ActualAmount = received + receivedSlices;
                item.RefundedAmount = 0m;
                continue;
            }

            // Spent: expense rows and slices, net of the refunds received against the line.
            var spent = lineSums
                .Where(s => s.Type == TransactionType.Expense)
                .Sum(s => s.Total);
            var spentSlices = splitSums.TryGetValue((item.Id, TransactionType.Expense), out var v) ? v : 0m;
            var refunded = lineSums
                .Where(s => s.IsRefund)
                .Sum(s => s.Total);
            item.RefundedAmount = refunded;
            item.ActualAmount = spent + spentSlices - refunded;
        }

        if (savingsBalances)
        {
            foreach (var month in months)
            {
                await ApplySavingsBalancesAsync(db, ownerId, month, cancellationToken);
            }
        }
    }

    /// <summary>
    /// For each of <paramref name="months"/>, how many of the household's rows dated in it still
    /// wait for their budget-currency amount (rule 44): one query over the span they cover.
    /// </summary>
    public static async Task<Dictionary<(int Year, int Month), int>> FxPendingCountsAsync(
        IApplicationDbContext db,
        string ownerId,
        IEnumerable<(int Year, int Month)> months,
        CancellationToken cancellationToken)
    {
        var asked = months.Distinct().ToList();
        if (asked.Count == 0)
        {
            return new Dictionary<(int Year, int Month), int>();
        }
        var (from, through) = Span(asked);
        if (from > through)
        {
            return new Dictionary<(int Year, int Month), int>();
        }
        var counts = await db.Transactions
            .Where(HouseholdMoney.Counts(db))
            .Where(t => t.OwnerId == ownerId && t.FxPending && t.Date >= from && t.Date <= through)
            .GroupBy(t => new { t.Date.Year, t.Date.Month })
            .Select(g => new { g.Key.Year, g.Key.Month, Count = g.Count() })
            .ToListAsync(cancellationToken);
        return counts.ToDictionary(c => (c.Year, c.Month), c => c.Count);
    }

    /// <summary>
    /// The dates from the first of these months to the last day of the last. A year no date can
    /// have (a report asked for year 0) is left out, as it holds no rows; when no month is left the
    /// span is empty (From after Through), so a caller can skip its query.
    /// </summary>
    public static (DateOnly From, DateOnly Through) Span(IReadOnlyCollection<(int Year, int Month)> months)
    {
        var dated = months.Where(m => m.Year is >= 1 and <= 9999).ToList();
        if (dated.Count == 0)
        {
            return (DateOnly.MaxValue, DateOnly.MinValue);
        }
        var first = dated.Min();
        var last = dated.Max();
        return (new DateOnly(first.Year, first.Month, 1),
            new DateOnly(last.Year, last.Month, DateTime.DaysInMonth(last.Year, last.Month)));
    }

    /// <summary>
    /// Sets <see cref="BudgetItem.SavingsAvailable"/> on each of the viewed month's jar lines to
    /// the jar's actual balance as of the end of that month (rule 48) — the allocations posted in
    /// its account, never the planned contributions (rule 1). Null when the account's balance is
    /// unavailable (rule 67). The current and future months read as of today.
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

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var monthEnd = new DateOnly(month.Year, month.Month, 1).AddMonths(1).AddDays(-1);
        var asOf = monthEnd < today ? monthEnd : today;
        var snapshot = await Jars.JarLedgerReader.ReadAsync(db, ownerId, asOf, cancellationToken);

        foreach (var item in savingsItems)
        {
            item.SavingsAvailable = snapshot.BalanceOf(item.SavingsId!.Value);
        }
    }
}
