using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets.Commands.AddBudgetCategory;

public class AddBudgetCategoryCommandHandler : IRequestHandler<AddBudgetCategoryCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public AddBudgetCategoryCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(AddBudgetCategoryCommand request, CancellationToken cancellationToken)
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

        // Ownership re-check (defence in depth — never trust the id alone).
        if (month.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Append after the existing groups of the same kind (expense or fund), so
        // each kind keeps its own contiguous display order.
        var sameKindOrders = month.Categories
            .Where(c => c.Kind == request.Kind)
            .Select(c => c.DisplayOrder)
            .ToList();
        var nextOrder = sameKindOrders.Count == 0 ? 0 : sameKindOrders.Max() + 1;

        _db.BudgetCategories.Add(new BudgetCategory
        {
            BudgetMonthId = month.Id,
            Name = request.Name.Trim(),
            Kind = request.Kind,
            DisplayOrder = nextOrder,
        });

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
