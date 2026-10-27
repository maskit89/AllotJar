using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Reports;
using AllotJar.Application.Reports.Dtos;
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
        var reports = await ReportsAsync(db, userId, from, lastStart, cancellationToken);
        var ledger = await JarLedgerReader.LoadAsync(db, userId, cancellationToken);
        return Figures(reports, ledger, from, lastStart.AddMonths(1).AddDays(-1));
    }

    /// <summary>
    /// One month's own figures and what the months before it carried in, counted from the
    /// household's first budget: each month's figures add up, so money carried in and then spent
    /// nets back to zero, and money nobody gave a job keeps carrying. Read in one pass over the
    /// chain (one report read, one jar ledger). A month before the first budget is outside the
    /// chain (<c>InChain</c> false): it carries nothing in and passes nothing on.
    /// </summary>
    public static async Task<(decimal CarriedIn, MonthLeftoverFigures Month, bool InChain)> WithCarryAsync(
        IApplicationDbContext db,
        string userId,
        int year,
        int month,
        CancellationToken cancellationToken)
    {
        var target = new DateOnly(year, month, 1);
        var targetEnd = target.AddMonths(1).AddDays(-1);
        var firstBudget = await db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == userId)
            .OrderBy(m => m.Year)
                .ThenBy(m => m.Month)
            .Select(m => new { m.Year, m.Month })
            .FirstOrDefaultAsync(cancellationToken);
        var first = firstBudget is null ? (DateOnly?)null : new DateOnly(firstBudget.Year, firstBudget.Month, 1);
        var inChain = first is not null && first <= target;
        var from = inChain ? first!.Value : target;

        var reports = await ReportsAsync(db, userId, from, target, cancellationToken);
        var ledger = await JarLedgerReader.LoadAsync(db, userId, cancellationToken);
        var own = Figures(reports.Where(r => r.Year == year && r.Month == month).ToList(), ledger, target, targetEnd);
        var carried = inChain && from < target
            ? Figures(reports.Where(r => r.Year != year || r.Month != month).ToList(), ledger, from, target.AddDays(-1)).LeftOver
            : 0m;
        return (carried, own, inChain);
    }

    /// <summary>What the months before <paramref name="year"/>/<paramref name="month"/> left over in all: the money it carries in. Zero for the first budget, or a month before it.</summary>
    public static async Task<decimal> CarriedIntoAsync(
        IApplicationDbContext db,
        string userId,
        int year,
        int month,
        CancellationToken cancellationToken)
    {
        var before = new DateOnly(year, month, 1).AddMonths(-1);
        var (carried, own, inChain) = await WithCarryAsync(db, userId, before.Year, before.Month, cancellationToken);
        return inChain ? carried + own.LeftOver : 0m;
    }

    /// <summary>The report figures of every calendar month from <paramref name="from"/> through <paramref name="lastStart"/>, each with its budget when it has one.</summary>
    private static async Task<List<MonthReportDto>> ReportsAsync(
        IApplicationDbContext db, string userId, DateOnly from, DateOnly lastStart, CancellationToken cancellationToken)
    {
        var budgets = await db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year > from.Year || (m.Year == from.Year && m.Month >= from.Month))
                        && (m.Year < lastStart.Year || (m.Year == lastStart.Year && m.Month <= lastStart.Month)))
            .ToListAsync(cancellationToken);
        var byKey = budgets.ToDictionary(b => (b.Year, b.Month));
        var months = new List<(int Year, int Month, BudgetMonth? Budget)>();
        for (var m = from; m <= lastStart; m = m.AddMonths(1))
        {
            months.Add((m.Year, m.Month, byKey.GetValueOrDefault((m.Year, m.Month))));
        }
        return await ReportFigures.ForMonthsAsync(db, userId, months, cancellationToken);
    }

    /// <summary>The figures of the dates <paramref name="from"/> to <paramref name="to"/>, from those months' reports and the jar ledger.</summary>
    private static MonthLeftoverFigures Figures(IReadOnlyCollection<MonthReportDto> reports, JarLedgerSource ledger, DateOnly from, DateOnly to)
    {
        var (postings, _) = ledger.SpendingBetween(from, to);
        // What jars paid, net of the refunds that came back into them.
        var paidByJars = postings.Sum(p => p.IsRefund ? -p.Amount : p.Amount);
        var setAside = ledger.SetAsideBetween(from, to).Values.Sum();
        var jarsChange = JarTotal(ledger.At(to)) - JarTotal(ledger.At(from.AddDays(-1)));
        return new MonthLeftoverFigures(
            reports.Sum(r => r.IncomeReceived),
            reports.Sum(r => r.Spent) - paidByJars,
            jarsChange + paidByJars - setAside,
            reports.Sum(r => r.FxPendingCount));
    }

    private static decimal JarTotal(JarLedgerSnapshot snapshot) =>
        snapshot.Jars.Keys.Sum(id => snapshot.BalanceOf(id) ?? 0m);
}
