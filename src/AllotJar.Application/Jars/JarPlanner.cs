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
/// A month at or before the current one is planned from the jar's actual balance as of the end of
/// the previous month (rules 13 and 48: money that arrived later never changes an earlier month's
/// requirement). A later month is projected from the current month: the balance entering it plus
/// each intervening month's plan — the stored savings line where that month exists, the schedule's
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
        if (target <= current)
        {
            var snapshot = await JarLedgerReader.ReadAsync(db, ownerId, target.AddDays(-1), cancellationToken);
            foreach (var jar in scheduled)
            {
                result[jar.Id] = JarSchedule.PlannedFor(jar, target, snapshot.BalanceOf(jar.Id) ?? 0m);
            }
            return result;
        }

        var opening = await JarLedgerReader.ReadAsync(db, ownerId, current.AddDays(-1), cancellationToken);
        var stored = await StoredPlansAsync(db, ownerId, scheduled.Select(j => j.Id).ToList(), current, target, cancellationToken);
        foreach (var jar in scheduled)
        {
            var balance = opening.BalanceOf(jar.Id) ?? 0m;
            for (var m = current; m < target; m = m.AddMonths(1))
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
    /// The jar's schedule from the current month: planned from its balance entering the month
    /// plus <paramref name="extraBalance"/> (money set aside at creation, which the ledger as of
    /// the previous month end cannot see yet). The figures a new jar plants and a preview shows.
    /// </summary>
    public static async Task<JarPlan> ScheduleAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly today, decimal extraBalance, CancellationToken cancellationToken)
    {
        var current = new DateOnly(today.Year, today.Month, 1);
        var opening = await JarLedgerReader.ReadAsync(db, ownerId, current.AddDays(-1), cancellationToken, new[] { jar.FundingAccountId });
        return JarSchedule.Plan(jar, today, (opening.BalanceOf(jar.Id) ?? 0m) + extraBalance);
    }

    /// <summary>
    /// Writes the jar's schedule into every already-created month from the current one forward:
    /// its line's planned amount where the month has one, a new line where it does not (months
    /// created later get theirs from month creation). Past months are history and stay untouched
    /// (rule 46); money is never moved. Used when a jar is created (so it starts filling without a
    /// manual Budget-page step) and when its target, deadline or plan changes.
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

        var opening = await JarLedgerReader.ReadAsync(db, ownerId, current.AddDays(-1), cancellationToken, new[] { jar.FundingAccountId });
        var balance = (opening.BalanceOf(jar.Id) ?? 0m) + extraBalance;
        // Months that don't exist between two that do still take their planned amount toward the
        // projected balance, so a gap never inflates the month after it.
        var next = current;
        foreach (var month in months)
        {
            var first = new DateOnly(month.Year, month.Month, 1);
            for (; next < first; next = next.AddMonths(1))
            {
                balance += JarSchedule.PlannedFor(jar, next, balance);
            }

            var planned = JarSchedule.PlannedFor(jar, first, balance);
            var lines = month.Categories.SelectMany(c => c.Items).Where(i => i.SavingsId == jar.Id).ToList();
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
            balance += planned;
            next = first.AddMonths(1);
        }
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
