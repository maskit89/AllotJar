using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Commands.ReorderBudgetCategories;

public class ReorderBudgetCategoriesCommandHandler : IRequestHandler<ReorderBudgetCategoriesCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ReorderBudgetCategoriesCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(ReorderBudgetCategoriesCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var month = await _db.BudgetMonths
            .Include(m => m.Categories)
            .FirstOrDefaultAsync(m => m.Id == request.BudgetMonthId, cancellationToken);

        if (month is null)
        {
            throw new NotFoundException($"Budget month {request.BudgetMonthId} was not found.");
        }
        if (month.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Every id provided must belong to this month (defence in depth).
        var byId = month.Categories.ToDictionary(c => c.Id);
        if (request.OrderedCategoryIds.Any(id => !byId.ContainsKey(id)))
        {
            throw new NotFoundException("One or more categories do not belong to this budget.");
        }

        for (var i = 0; i < request.OrderedCategoryIds.Count; i++)
        {
            byId[request.OrderedCategoryIds[i]].DisplayOrder = i;
        }

        await _db.SaveChangesAsync(cancellationToken);

        var reloaded = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == month.Id, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, reloaded, cancellationToken);

        return reloaded.ToDto();
    }
}
