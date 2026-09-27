using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Queries.GetJarSchedule;

public class GetJarScheduleQueryHandler : IRequestHandler<GetJarScheduleQuery, JarScheduleDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarScheduleQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarScheduleDto> Handle(GetJarScheduleQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        // The definition being previewed, as the create/update handlers would store it. For an
        // edit it keeps the stored jar's identity and account so the ledger finds its balance.
        Jar? existing = null;
        if (request.JarId is { } id)
        {
            existing = await _db.Jars.AsNoTracking().FirstOrDefaultAsync(j => j.Id == id, cancellationToken)
                ?? throw new NotFoundException($"Jar {id} was not found.");
            if (existing.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
            // The preview of an edit starts from the cycle the jar is actually in (rule 21).
            if (await JarCycles.SettleAsync(_db, userId, today, cancellationToken, existing.Id))
            {
                existing = await _db.Jars.AsNoTracking().FirstAsync(j => j.Id == id, cancellationToken);
            }
        }
        var (anchor, cycleDeadline) = JarCycles.DeadlinesFor(existing, request.Kind, request.TargetDate);
        var jar = new Jar
        {
            Id = existing?.Id ?? Guid.NewGuid(),
            OwnerId = userId,
            Kind = request.Kind,
            TargetAmount = request.TargetAmount,
            TargetDate = anchor,
            CycleDeadline = cycleDeadline,
            Accrual = request.Accrual,
            MonthlyContribution = request.Accrual == AccrualMethod.FixedMonthly ? request.MonthlyContribution : null,
            IncludeDeadlineMonth = request.Accrual == AccrualMethod.TargetByDate && request.IncludeDeadlineMonth,
            RecurMonths = request.Kind == JarKind.Recurring ? request.RecurMonths ?? existing?.RecurMonths ?? 12 : null,
            FundingAccountId = existing?.FundingAccountId ?? Guid.Empty,
        };

        var extra = existing is null ? request.InitialAllocation : 0m;
        var balances = await JarPlanner.BalancesAsync(_db, userId, jar, today, extra, cancellationToken);
        var plan = JarSchedule.Plan(jar, today, balances.Planning);
        var balance = balances.Planning;

        // Rule 59: where a planned month already has a budget, say how far the full contribution
        // would push it over its income — shown, never trimmed.
        var months = plan.Months.Select(m => new JarScheduleMonthDto { Year = m.Year, Month = m.Month, Planned = m.Planned }).ToList();
        if (months.Count > 0)
        {
            var firstKey = (months[0].Year * 12) + months[0].Month;
            var lastKey = (months[^1].Year * 12) + months[^1].Month;
            var budgets = await _db.BudgetMonths
                .AsNoTracking()
                .Include(b => b.Categories).ThenInclude(c => c.Items)
                .Where(b => b.OwnerId == userId
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
        };
    }
}
