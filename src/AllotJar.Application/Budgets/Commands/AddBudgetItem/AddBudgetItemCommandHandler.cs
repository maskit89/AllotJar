using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets.Commands.AddBudgetItem;

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

        // A line in a Savings group is a jar's monthly contribution. SavingsId is an
        // enforced FK to Jars.Id, so the line must be backed by a real jar (created
        // here, shaped later on the Jars page) — never a bare Guid, which violates
        // the constraint on SQL Server and leaves a line no jar can follow.
        Guid? savingsId = null;
        if (category.Kind == CategoryKind.Savings)
        {
            var jar = Jar.ForSavingsLine(userId, request.Name.Trim());
            _db.Jars.Add(jar);
            savingsId = jar.Id;
        }

        _db.BudgetItems.Add(new BudgetItem
        {
            BudgetCategoryId = category.Id,
            Name = request.Name.Trim(),
            PlannedAmount = request.PlannedAmount,
            DisplayOrder = nextOrder,
            SavingsId = savingsId,
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
