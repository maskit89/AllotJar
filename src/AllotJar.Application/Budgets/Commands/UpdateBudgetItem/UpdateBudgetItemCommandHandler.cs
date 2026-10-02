using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Budgets.Commands.UpdateBudgetItem;

public class UpdateBudgetItemCommandHandler : IRequestHandler<UpdateBudgetItemCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateBudgetItemCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(UpdateBudgetItemCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Load the line together with its owning category + month so we can both
        // re-verify ownership and recompute the month after the edit.
        var item = await _db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .FirstOrDefaultAsync(i => i.Id == request.BudgetItemId, cancellationToken);

        if (item is null)
        {
            throw new NotFoundException($"Budget item {request.BudgetItemId} was not found.");
        }

        // Ownership re-check (defence in depth — never trust the id alone).
        if (item.BudgetCategory.BudgetMonth.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var jar = item.SavingsId is { } jarId
            ? await _db.Jars.FirstOrDefaultAsync(j => j.Id == jarId && j.OwnerId == userId, cancellationToken)
            : null;
        var changed = request.PlannedAmount != item.PlannedAmount || (request.Name is not null && request.Name != item.Name);
        if (jar is { IsArchived: true } && changed)
        {
            // An archived jar plans nothing (rule 27): its line stays as the archive left it, a
            // skipped later month included, so a restore still plans around it (D18).
            throw JarAccounts.Validation(nameof(UpdateBudgetItemCommand.PlannedAmount),
                $"{jar.Name} is archived and plans no contributions. Restore {jar.Name} on the Jars page to plan it again.");
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var month = item.BudgetCategory.BudgetMonth;
        var unskipping = item.IsSkipped && request.PlannedAmount != 0m;
        if (unskipping && jar is not null && JarSchedule.IsPlanning(jar) && JarSchedule.HasSchedule(jar)
            && (month.Year > today.Year || (month.Year == today.Year && month.Month >= today.Month)))
        {
            // A typed amount is a plan for the month and the skip (rule 60) is over: the other
            // months give back what they carried for it (rule 61), as "Plan it again" does, but
            // around the typed amount. The replant runs with the month still skipped and the typed
            // amount counted as saved, so the remaining months carry the rest of the plan (D14).
            // Only inside the plan window: money typed for a month after the deadline's last
            // contribution month (a Recurring jar's next cycle, a Goal past its date) can't fund
            // it, so there the skip just ends, as before (review round 1, P2-1).
            await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);
            if (InPlanWindow(jar, new DateOnly(month.Year, month.Month, 1), today))
            {
                await JarPlanner.ReplantAsync(_db, userId, jar, today, request.PlannedAmount, cancellationToken);
            }
        }

        item.PlannedAmount = request.PlannedAmount;
        if (unskipping)
        {
            item.IsSkipped = false;
        }
        if (request.Name is not null)
        {
            item.Name = request.Name;
        }

        await _db.SaveChangesAsync(cancellationToken);

        // Reload the full month graph so the recomputed RemainingToBudget is returned.
        var monthId = item.BudgetCategory.BudgetMonthId;
        var updated = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == monthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, updated, cancellationToken);

        return updated.ToDto();
    }

    /// <summary>
    /// Whether <paramref name="month"/> is one the jar's plan spreads over: for a deadline plan, up
    /// to the deadline's last contribution month (or the current month when that has passed, as the
    /// planner clamps it); a fixed monthly plan runs on until its target, so every month.
    /// </summary>
    private static bool InPlanWindow(Jar jar, DateOnly month, DateOnly today)
    {
        if (jar.Accrual != AccrualMethod.TargetByDate || JarSchedule.CurrentDeadline(jar) is not { } deadline)
        {
            return true;
        }

        var end = JarSchedule.FundingCompletionMonth(jar, deadline);
        var current = new DateOnly(today.Year, today.Month, 1);
        return month <= (end < current ? current : end);
    }
}
