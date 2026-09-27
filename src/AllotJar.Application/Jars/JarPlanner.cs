using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// Turns <see cref="JarSchedule"/> into budget lines. Every planned figure a month carries for a
/// jar comes from here — month creation, a new jar planting its lines, a jar edit revising them
/// (rule 46) and the form's preview — so the preview, the saved plans and the Jars page agree.
///
/// A past month is planned from the jar's actual balance as of the end of the month before it
/// (rules 13 and 48: money that arrived later never changes an earlier month's requirement). The
/// current month is planned from its <see cref="PlanningBalance"/>: the balance it entered the
/// month with, or what the jar holds today when that is lower — money that arrives during the
/// month never shrinks the month's plan (rule 14), money that leaves it (the bill a Recurring
/// cycle was saving for, W03) counts at once. A later month is projected from the current one:
/// what the jar holds today plus what this month's plan has still to contribute, then each
/// intervening month's plan — the stored savings line where that month exists, the schedule's
/// own figure where it does not — because the plan assumes the plan is kept; rule 13's
/// recalculation at each month start corrects it from what was actually saved.
/// </summary>
public static class JarPlanner
{
    /// <summary>What each of <paramref name="jars"/> plans for the given month (0 for a jar with no schedule).</summary>
    public static async Task<IReadOnlyDictionary<Guid, decimal>> PlanMonthAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyCollection<Jar> jars,
        int year,
        int month,
        DateOnly today,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, decimal>();
        var scheduled = jars.Where(JarSchedule.HasSchedule).ToList();
        foreach (var jar in jars)
        {
            result[jar.Id] = 0m;
        }
        if (scheduled.Count == 0)
        {
            return result;
        }

        var target = new DateOnly(year, month, 1);
        var current = new DateOnly(today.Year, today.Month, 1);
        if (target < current)
        {
            var snapshot = await JarLedgerReader.ReadAsync(db, ownerId, target.AddDays(-1), cancellationToken);
            foreach (var jar in scheduled)
            {
                result[jar.Id] = JarSchedule.PlannedFor(jar, target, snapshot.BalanceOf(jar.Id) ?? 0m);
            }
            return result;
        }

        var opening = await JarLedgerReader.ReadAsync(db, ownerId, current.AddDays(-1), cancellationToken);
        var now = await JarLedgerReader.ReadAsync(db, ownerId, today, cancellationToken);
        if (target == current)
        {
            foreach (var jar in scheduled)
            {
                result[jar.Id] = JarSchedule.PlannedFor(jar, target, PlanningBalance(opening.BalanceOf(jar.Id), now.BalanceOf(jar.Id)));
            }
            return result;
        }

        var stored = await StoredPlansAsync(db, ownerId, scheduled.Select(j => j.Id).ToList(), current, target, cancellationToken);
        foreach (var jar in scheduled)
        {
            var planningBalance = PlanningBalance(opening.BalanceOf(jar.Id), now.BalanceOf(jar.Id));
            var thisMonth = stored.TryGetValue((jar.Id, current.Year, current.Month), out var storedNow)
                ? storedNow
                : JarSchedule.PlannedFor(jar, current, planningBalance);
            var balance = ProjectedMonthEnd(planningBalance, now.BalanceOf(jar.Id) ?? 0m, thisMonth);
            for (var m = current.AddMonths(1); m < target; m = m.AddMonths(1))
            {
                balance += stored.TryGetValue((jar.Id, m.Year, m.Month), out var planned)
                    ? planned
                    : JarSchedule.PlannedFor(jar, m, balance);
            }
            result[jar.Id] = JarSchedule.PlannedFor(jar, target, balance);
        }
        return result;
    }

    /// <summary>
    /// The balance the current month is planned from: the balance the jar entered the month with
    /// (rule 13), or what it holds today when that is lower — money leaving the jar during the
    /// month counts at once, money arriving does not (rule 14). An unavailable balance plans from
    /// nothing (rule 67: never invented).
    /// </summary>
    public static decimal PlanningBalance(decimal? opening, decimal? now) =>
        Math.Min(opening ?? 0m, now ?? 0m);

    /// <summary>
    /// What the jar is assumed to hold as the current month ends: what it holds now plus what
    /// this month's plan has still to contribute (plan − contributed so far, floored at zero).
    /// </summary>
    public static decimal ProjectedMonthEnd(decimal planningBalance, decimal now, decimal plannedThisMonth) =>
        now + Math.Max(0m, plannedThisMonth - Math.Max(0m, now - planningBalance));

    /// <summary>The jar's balance entering the current month, today, and the one this month plans from, plus <paramref name="extraBalance"/> (money set aside at creation, not yet in the ledger).</summary>
    public static async Task<(decimal Opening, decimal Now, decimal Planning)> BalancesAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly today, decimal extraBalance, CancellationToken cancellationToken)
    {
        var current = new DateOnly(today.Year, today.Month, 1);
        var opening = await JarLedgerReader.ReadAsync(db, ownerId, current.AddDays(-1), cancellationToken, new[] { jar.FundingAccountId });
        var now = await JarLedgerReader.ReadAsync(db, ownerId, today, cancellationToken, new[] { jar.FundingAccountId });
        var openingBalance = opening.BalanceOf(jar.Id);
        var nowBalance = now.BalanceOf(jar.Id);
        return ((openingBalance ?? 0m) + extraBalance, (nowBalance ?? 0m) + extraBalance, PlanningBalance(openingBalance, nowBalance) + extraBalance);
    }

    /// <summary>
    /// The jar's schedule from the current month: planned from its <see cref="PlanningBalance"/>
    /// plus <paramref name="extraBalance"/> (money set aside at creation, which the ledger cannot
    /// see yet). The figures a new jar plants and a preview shows.
    /// </summary>
    public static async Task<JarPlan> ScheduleAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly today, decimal extraBalance, CancellationToken cancellationToken)
    {
        var balances = await BalancesAsync(db, ownerId, jar, today, extraBalance, cancellationToken);
        return JarSchedule.Plan(jar, today, balances.Planning);
    }

    /// <summary>
    /// Writes the jar's schedule into every already-created month from the current one forward:
    /// its line's planned amount where the month has one, a new line where it does not (months
    /// created later get theirs from month creation). Past months are history and stay untouched
    /// (rule 46); money is never moved. Used when a jar is created (so it starts filling without a
    /// manual Budget-page step), when its target, deadline or plan changes, and when a Recurring
    /// cycle closes (W03).
    /// </summary>
    public static async Task ReplantAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly today, decimal extraBalance, CancellationToken cancellationToken)
    {
        var current = new DateOnly(today.Year, today.Month, 1);
        var months = await db.BudgetMonths
            .Include(m => m.Categories.Where(c => c.Kind == CategoryKind.Savings))
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == ownerId
                        && (m.Year > today.Year || (m.Year == today.Year && m.Month >= today.Month)))
            .OrderBy(m => m.Year).ThenBy(m => m.Month)
            .ToListAsync(cancellationToken);
        if (months.Count == 0)
        {
            return;
        }

        var balances = await BalancesAsync(db, ownerId, jar, today, extraBalance, cancellationToken);
        var balance = balances.Planning;
        // Months that don't exist between two that do still take their planned amount toward the
        // projected balance, so a gap never inflates the month after it.
        var next = current;
        foreach (var month in months)
        {
            var first = new DateOnly(month.Year, month.Month, 1);
            for (; next < first; next = next.AddMonths(1))
            {
                balance = Advance(next, balance, JarSchedule.PlannedFor(jar, next, balance));
            }

            var planned = JarSchedule.PlannedFor(jar, first, balance);
            // DistinctBy: a line already tracked through another navigation can appear twice in
            // the included collection; it is still one line.
            var lines = month.Categories.SelectMany(c => c.Items).Where(i => i.SavingsId == jar.Id).DistinctBy(i => i.Id).ToList();
            if (lines.Count == 0)
            {
                SavingsLines.AppendJarLine(db, month, jar, planned);
            }
            else
            {
                // One line carries the plan; any duplicate (a copied month that already had one) drops to 0.
                lines[0].PlannedAmount = planned;
                foreach (var extra in lines.Skip(1))
                {
                    extra.PlannedAmount = 0m;
                }
            }
            balance = Advance(first, balance, planned);
            next = first.AddMonths(1);
        }

        // The balance a month is assumed to end with: the current month projects from what the
        // jar holds today (see ProjectedMonthEnd); a later month simply keeps its plan.
        decimal Advance(DateOnly month, decimal from, decimal planned) =>
            month == current ? ProjectedMonthEnd(balances.Planning, balances.Now, planned) : from + planned;
    }

    private static async Task<Dictionary<(Guid JarId, int Year, int Month), decimal>> StoredPlansAsync(
        IApplicationDbContext db, string ownerId, List<Guid> jarIds, DateOnly from, DateOnly before, CancellationToken cancellationToken)
    {
        var fromKey = (from.Year * 12) + from.Month;
        var beforeKey = (before.Year * 12) + before.Month;
        var rows = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.SavingsId != null && jarIds.Contains(i.SavingsId.Value)
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && (i.BudgetCategory.BudgetMonth.Year * 12) + i.BudgetCategory.BudgetMonth.Month >= fromKey
                        && (i.BudgetCategory.BudgetMonth.Year * 12) + i.BudgetCategory.BudgetMonth.Month < beforeKey)
            .Select(i => new { JarId = i.SavingsId!.Value, i.BudgetCategory.BudgetMonth.Year, i.BudgetCategory.BudgetMonth.Month, i.PlannedAmount })
            .ToListAsync(cancellationToken);
        return rows
            .GroupBy(r => (r.JarId, r.Year, r.Month))
            .ToDictionary(g => g.Key, g => g.Sum(r => r.PlannedAmount));
    }
}
