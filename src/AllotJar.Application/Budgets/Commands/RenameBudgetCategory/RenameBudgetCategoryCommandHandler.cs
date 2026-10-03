using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Commands.RenameBudgetCategory;

public class RenameBudgetCategoryCommandHandler : IRequestHandler<RenameBudgetCategoryCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public RenameBudgetCategoryCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(RenameBudgetCategoryCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var category = await _db.BudgetCategories
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
        _db.ExpectVersion(category, request.Version);

        category.Name = request.Name.Trim();
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
