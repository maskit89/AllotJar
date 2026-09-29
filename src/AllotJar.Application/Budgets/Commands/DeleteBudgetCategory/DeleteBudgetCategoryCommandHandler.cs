using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets.Commands.DeleteBudgetCategory;

public class DeleteBudgetCategoryCommandHandler : IRequestHandler<DeleteBudgetCategoryCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DeleteBudgetCategoryCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(DeleteBudgetCategoryCommand request, CancellationToken cancellationToken)
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

        // The Income group is structural — a budget always has exactly one.
        if (category.Kind == CategoryKind.Income)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.CategoryId)] = new[] { "The Income group cannot be deleted." },
            });
        }

        // Rule 60: a jar's line leaves a month only by skipping that month's contribution or
        // archiving the jar (DeleteBudgetItem refuses it alone), so a group that still holds one
        // cannot take it with it. On a month that is over it would also rewrite the month's jar
        // history (rule 46), and on a later one leave the jars planning what the grid does not.
        var jarLineIds = category.Items.Where(i => i.SavingsId is not null).Select(i => i.SavingsId!.Value).ToList();
        if (jarLineIds.Count > 0)
        {
            var jarNames = await _db.Jars
                .Where(j => jarLineIds.Contains(j.Id))
                .OrderBy(j => j.Name)
                .Select(j => j.Name)
                .ToListAsync(cancellationToken);
            if (jarNames.Count > 0)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    [nameof(request.CategoryId)] = new[]
                    {
                        $"{category.Name} holds {(jarNames.Count == 1 ? "a jar's monthly contribution" : "jars' monthly contributions")} ({string.Join(", ", jarNames)}). "
                        + "Skip this month's contribution or archive the jar instead; a group can be deleted once it holds no jar's line.",
                    },
                });
            }
        }

        await PrivateLineEntries.EnsureNoneAsync(
            _db, _currentUser, category.Items.Select(i => i.Id).ToList(), category.Name, nameof(request.CategoryId), cancellationToken);

        var monthId = category.BudgetMonthId;

        // Remove the lines explicitly (the relational cascade also covers this,
        // but being explicit keeps the in-memory provider's behaviour identical).
        _db.BudgetItems.RemoveRange(category.Items);
        _db.BudgetCategories.Remove(category);
        await _db.SaveChangesAsync(cancellationToken);

        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == monthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
