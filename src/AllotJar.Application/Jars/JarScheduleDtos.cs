using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>Turns a <see cref="JarPlan"/> into the preview DTO, with rule 59's per-month shortfalls against the budgets that already exist.</summary>
public static class JarScheduleDtos
{
    public static async Task<JarScheduleDto> BuildAsync(
        IApplicationDbContext db, string ownerId, Jar jar, JarPlan plan, decimal balance, CancellationToken cancellationToken)
    {
        // Rule 59: where a planned month already has a budget, say how far the full contribution
        // would push it over its income — shown, never trimmed.
        var months = plan.Months
            .Select(m => new JarScheduleMonthDto { Year = m.Year, Month = m.Month, Planned = m.Planned, Skipped = m.Skipped, ByHand = m.ByHand })
            .ToList();
        if (months.Count > 0)
        {
            var firstKey = (months[0].Year * 12) + months[0].Month;
            var lastKey = (months[^1].Year * 12) + months[^1].Month;
            var budgets = await db.BudgetMonths
                .AsNoTracking()
                .Include(b => b.Categories).ThenInclude(c => c.Items)
                .Where(b => b.OwnerId == ownerId
                            && (b.Year * 12) + b.Month >= firstKey
                            && (b.Year * 12) + b.Month <= lastKey)
                .ToListAsync(cancellationToken);
            foreach (var month in months)
            {
                var budget = budgets.FirstOrDefault(b => b.Year == month.Year && b.Month == month.Month);
                if (budget is null)
                {
                    continue;
                }
                month.HasBudget = true;
                var currentLine = budget.Categories.SelectMany(c => c.Items)
                    .Where(i => i.SavingsId == jar.Id)
                    .Sum(i => i.PlannedAmount);
                var plannedWithThis = budget.TotalPlanned - currentLine + month.Planned;
                month.Shortfall = Math.Max(0m, plannedWithThis - budget.TotalIncome);
            }
        }

        return new JarScheduleDto
        {
            Accrual = jar.Accrual,
            IsOngoing = plan.IsOngoing,
            HasSchedule = JarSchedule.HasSchedule(jar),
            Balance = balance,
            Remaining = plan.Remaining,
            Months = months,
            Total = plan.Total,
            Deadline = plan.Deadline ?? JarSchedule.CurrentDeadline(jar),
            FundingCompletesOn = plan.FundingCompletesOn,
            EstimatedMonths = plan.EstimatedMonths,
            Unplanned = plan.Unplanned,
            ByHandLater = plan.ByHandLater
                .Select(m => new JarScheduleMonthDto { Year = m.Year, Month = m.Month, Planned = m.Planned, ByHand = true, HasBudget = true })
                .ToList(),
        };
    }
}
