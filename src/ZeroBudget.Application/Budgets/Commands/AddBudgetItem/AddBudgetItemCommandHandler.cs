using MediatR;
using Microsoft.EntityFrameworkCore;
using ZeroBudget.Application.Budgets.Dtos;
using ZeroBudget.Application.Common.Exceptions;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Domain.Entities;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Application.Budgets.Commands.AddBudgetItem;

public class AddBudgetItemCommandHandler : IRequestHandler<AddBudgetItemCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public AddBudgetItemCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(AddBudgetItemCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Load the target category together with its items (to pick the next
        // display order) and its owning month (to re-verify ownership).
        var category = await _db.BudgetCategories
            .Include(c => c.Items)
            .Include(c => c.BudgetMonth)
            .FirstOrDefaultAsync(c => c.Id == request.CategoryId, cancellationToken);

        if (category is null)
        {
            throw new NotFoundException($"Budget category {request.CategoryId} was not found.");
        }

        // Ownership re-check (defence in depth — never trust the id alone).
        if (category.BudgetMonth.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var nextOrder = category.Items.Count == 0 ? 0 : category.Items.Max(i => i.DisplayOrder) + 1;

        _db.BudgetItems.Add(new BudgetItem
        {
            BudgetCategoryId = category.Id,
            Name = request.Name.Trim(),
            PlannedAmount = request.PlannedAmount,
            DisplayOrder = nextOrder,
            // A line in a Fund group is a sinking fund — give it a stable id so its
            // balance can roll over across months.
            SavingsId = category.Kind == CategoryKind.Savings ? Guid.NewGuid() : null,
        });

        await _db.SaveChangesAsync(cancellationToken);

        // Reload the full month graph so the recomputed totals are returned.
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == category.BudgetMonthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
