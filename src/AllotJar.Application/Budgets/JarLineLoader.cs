using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Budgets;

/// <summary>
/// Loads a jar's Savings line for a skip (rule 60) or its preview (rule 61) and checks what
/// both need: the line is the caller's, it belongs to a live jar of theirs, and its month is the
/// current one or later — a past month's contribution is history and cannot be skipped.
/// </summary>
public static class JarLineLoader
{
    public static async Task<(BudgetItem Line, Jar Jar)> LoadAsync(
        IApplicationDbContext db, string ownerId, Guid budgetItemId, DateOnly today, CancellationToken cancellationToken)
    {
        var item = await db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .FirstOrDefaultAsync(i => i.Id == budgetItemId, cancellationToken)
            ?? throw new NotFoundException($"Budget item {budgetItemId} was not found.");

        if (item.BudgetCategory.BudgetMonth.OwnerId != ownerId)
        {
            throw new ForbiddenAccessException();
        }

        var jar = item.SavingsId is { } jarId
            ? await db.Jars.FirstOrDefaultAsync(j => j.Id == jarId && j.OwnerId == ownerId, cancellationToken)
            : null;
        if (jar is null)
        {
            throw JarAccounts.Validation("BudgetItemId", $"{item.Name} is not a jar's contribution line; only a jar's monthly contribution can be skipped.");
        }
        if (!JarSchedule.IsPlanning(jar))
        {
            throw JarAccounts.Validation("BudgetItemId",
                $"{jar.Name} is {(jar.IsArchived ? "archived" : "completed")} and plans no contributions; there is nothing to skip.");
        }

        var month = item.BudgetCategory.BudgetMonth;
        if (month.Year < today.Year || (month.Year == today.Year && month.Month < today.Month))
        {
            throw JarAccounts.Validation("BudgetItemId",
                $"{new DateOnly(month.Year, month.Month, 1):MMMM yyyy} is over; its planned contributions are history and cannot be skipped.");
        }

        return (item, jar);
    }
}
