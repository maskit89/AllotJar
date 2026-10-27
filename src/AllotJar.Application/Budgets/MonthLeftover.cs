using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Reports;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Budgets;

/// <summary>
/// What a stretch of months left over: the income received, less what was spent from the month's
/// own money, less what was put into jars. Every figure is actual money read from the ledger, never
/// a plan, so a back-dated correction (rule 49) moves it too.
/// <list type="bullet">
/// <item><b>Received</b> is the reports' income received (rule 41): no transfer, no refund.</item>
/// <item><b>Spent</b> is the reports' net spending (rules 37–39) less what jars paid: a bill paid
/// from a jar was saved for in earlier months, so it does not come out of this month's money.</item>
/// <item><b>Into jars</b> is the change in every jar's balance plus what jars paid, less the money
/// set aside when a jar was created (it was already saved, SC-P2-1). That is exactly the money moved
/// into jars from income or unallocated funds, net of any moved back out.</item>
/// </list>
/// Rows still waiting for their budget-currency amount count nowhere (rule 44), as in the reports.
/// </summary>
public sealed record MonthLeftoverFigures(decimal Received, decimal Spent, decimal IntoJars, int FxPendingCount)
{
    public decimal LeftOver => Received - Spent - IntoJars;

    public static readonly MonthLeftoverFigures None = new(0m, 0m, 0m, 0);
}

public static class MonthLeftover
{
    /// <summary>
    /// The figures of the calendar months from <paramref name="first"/> through <paramref name="last"/>
    /// (both inclusive), months without a budget included: money moves whether or not a month was
    /// planned. Empty (all zero) when <paramref name="last"/> is before <paramref name="first"/>.
    /// </summary>
    public static async Task<MonthLeftoverFigures> BetweenAsync(
        IApplicationDbContext db,
        string userId,
        (int Year, int Month) first,
        (int Year, int Month) last,
        CancellationToken cancellationToken)
    {
        var from = new DateOnly(first.Year, first.Month, 1);
        var lastStart = new DateOnly(last.Year, last.Month, 1);
        if (lastStart < from)
        {
            return MonthLeftoverFigures.None;
        }
        var to = lastStart.AddMonths(1).AddDays(-1);

        var budgets = await db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year > first.Year || (m.Year == first.Year && m.Month >= first.Month))
                        && (m.Year < last.Year || (m.Year == last.Year && m.Month <= last.Month)))
            .ToListAsync(cancellationToken);
        var byKey = budgets.ToDictionary(b => (b.Year, b.Month));
        var months = new List<(int Year, int Month, BudgetMonth? Budget)>();
        for (var m = from; m <= lastStart; m = m.AddMonths(1))
        {
            months.Add((m.Year, m.Month, byKey.GetValueOrDefault((m.Year, m.Month))));
        }
        var reports = await ReportFigures.ForMonthsAsync(db, userId, months, cancellationToken);
        var received = reports.Sum(r => r.IncomeReceived);
        var spent = reports.Sum(r => r.Spent);
        var waiting = reports.Sum(r => r.FxPendingCount);

        var ledger = await JarLedgerReader.LoadAsync(db, userId, cancellationToken);
        var (postings, _) = ledger.SpendingBetween(from, to);
        // What jars paid, net of the refunds that came back into them.
        var paidByJars = postings.Sum(p => p.IsRefund ? -p.Amount : p.Amount);
        var setAside = ledger.SetAsideBetween(from, to).Values.Sum();
        var jarsChange = JarTotal(ledger.At(to)) - JarTotal(ledger.At(from.AddDays(-1)));

        return new MonthLeftoverFigures(
            received,
            spent - paidByJars,
            jarsChange + paidByJars - setAside,
            waiting);
    }

    /// <summary>
    /// What the months before <paramref name="year"/>/<paramref name="month"/> left over in all,
    /// counted from the household's first budget: the money a new month carries in. Each month's
    /// own figures add up, so money carried in and then spent nets back to zero, and money nobody
    /// gave a job keeps carrying. Zero for the first budget, or for a month before it.
    /// </summary>
    public static async Task<decimal> CarriedIntoAsync(
        IApplicationDbContext db,
        string userId,
        int year,
        int month,
        CancellationToken cancellationToken)
    {
        var firstBudget = await db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == userId)
            .OrderBy(m => m.Year)
                .ThenBy(m => m.Month)
            .Select(m => new { m.Year, m.Month })
            .FirstOrDefaultAsync(cancellationToken);
        if (firstBudget is null)
        {
            return 0m;
        }
        var before = new DateOnly(year, month, 1).AddMonths(-1);
        var figures = await BetweenAsync(db, userId, (firstBudget.Year, firstBudget.Month), (before.Year, before.Month), cancellationToken);
        return figures.LeftOver;
    }

    private static decimal JarTotal(JarLedgerSnapshot snapshot) =>
        snapshot.Jars.Keys.Sum(id => snapshot.BalanceOf(id) ?? 0m);
}
