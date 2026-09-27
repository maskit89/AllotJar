using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
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

        // Income attribution: only income lines carry a member, and the member must be
        // this household's and active.
        if (request.MemberId is Guid memberId)
        {
            if (category.Kind != CategoryKind.Income)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["MemberId"] = new[] { "Only income lines can be assigned to a person." },
                });
            }
            var memberOk = await _db.HouseholdMembers
                .AnyAsync(m => m.Id == memberId && m.OwnerId == userId && !m.IsArchived, cancellationToken);
            if (!memberOk)
            {
                throw new NotFoundException($"Household member {memberId} was not found.");
            }
        }

        // A line in a Savings group is a jar's monthly contribution, and a jar needs its
        // designated account (rule 73): it is created through the jar form (POST /jars), which
        // plants this month's line itself. A bare savings line would be a plan with no money.
        if (category.Kind == CategoryKind.Savings)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Name"] = new[] { "A savings line is a jar. Create the jar, choosing the account that holds its money, and its contribution line is added here." },
            });
        }
        Guid? savingsId = null;

        _db.BudgetItems.Add(new BudgetItem
        {
            BudgetCategoryId = category.Id,
            Name = request.Name.Trim(),
            PlannedAmount = request.PlannedAmount,
            DisplayOrder = nextOrder,
            SavingsId = savingsId,
            MemberId = request.MemberId,
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
