using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets.Commands.SetBudgetItemMember;

public class SetBudgetItemMemberCommandHandler : IRequestHandler<SetBudgetItemMemberCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SetBudgetItemMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(SetBudgetItemMemberCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

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

        if (item.BudgetCategory.Kind != CategoryKind.Income)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["MemberId"] = new[] { "Only income lines can be assigned to a person." },
            });
        }

        if (request.MemberId is Guid memberId)
        {
            var memberOk = await _db.HouseholdMembers
                .AnyAsync(m => m.Id == memberId && m.OwnerId == userId && !m.IsArchived, cancellationToken);
            if (!memberOk)
            {
                throw new NotFoundException($"Household member {memberId} was not found.");
            }
        }

        item.MemberId = request.MemberId;
        await _db.SaveChangesAsync(cancellationToken);

        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == item.BudgetCategory.BudgetMonthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
