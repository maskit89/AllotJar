using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Commands.DeleteBudgetItem;

public class DeleteBudgetItemCommandHandler : IRequestHandler<DeleteBudgetItemCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DeleteBudgetItemCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(DeleteBudgetItemCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Load the line with its owning category + month so we can re-verify
        // ownership and recompute the month after removal.
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

        // Rule 60: removing a jar's line from a month is a choice — skip this month's
        // contribution, or archive the jar — never a bare deletion that the next month's
        // creation would quietly undo.
        if (item.SavingsId is { } jarId && await _db.Jars.AnyAsync(j => j.Id == jarId, cancellationToken))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.BudgetItemId)] = new[]
                {
                    $"{item.Name} is a jar's monthly contribution. Skip this month's contribution, or archive the jar to stop future ones.",
                },
            });
        }

        await PrivateLineEntries.EnsureNoneAsync(_db, _currentUser, new[] { item.Id }, item.Name, nameof(request.BudgetItemId), cancellationToken);

        var monthId = item.BudgetCategory.BudgetMonthId;

        _db.BudgetItems.Remove(item);
        await _db.SaveChangesAsync(cancellationToken);

        // Reload the full month graph so the recomputed totals are returned.
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == monthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
