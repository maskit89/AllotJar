using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Commands.ReorderBudgetItems;

public class ReorderBudgetItemsCommandHandler : IRequestHandler<ReorderBudgetItemsCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ReorderBudgetItemsCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(ReorderBudgetItemsCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var category = await _db.BudgetCategories
            .Include(c => c.Items)
            .Include(c => c.BudgetMonth)
            .FirstOrDefaultAsync(c => c.Id == request.CategoryId, cancellationToken);

        if (category is null)
        {
            throw new NotFoundException($"Budget category {request.CategoryId} was not found.");
        }
        if (category.BudgetMonth.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Every id provided must be a line in this category (defence in depth).
        var byId = category.Items.ToDictionary(i => i.Id);
        if (request.OrderedItemIds.Any(id => !byId.ContainsKey(id)))
        {
            throw new NotFoundException("One or more lines do not belong to this category.");
        }

        for (var i = 0; i < request.OrderedItemIds.Count; i++)
        {
            byId[request.OrderedItemIds[i]].DisplayOrder = i;
        }

        await _db.SaveChangesAsync(cancellationToken);

        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == category.BudgetMonthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
