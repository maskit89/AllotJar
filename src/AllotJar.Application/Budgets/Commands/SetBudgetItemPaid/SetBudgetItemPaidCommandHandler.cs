using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Commands.SetBudgetItemPaid;

public class SetBudgetItemPaidCommandHandler : IRequestHandler<SetBudgetItemPaidCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SetBudgetItemPaidCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(SetBudgetItemPaidCommand request, CancellationToken cancellationToken)
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

        // Only a bill (a line with a due day) can be paid. The page offers
        // "Mark paid" on bills only, so this guards a stale tab or a hand-made
        // request. Marking unpaid is always allowed.
        if (request.IsPaid && item.DueDay is null)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["IsPaid"] = ["Only a bill with a due day can be marked paid."],
            });
        }

        item.IsPaid = request.IsPaid;
        await _db.SaveChangesAsync(cancellationToken);

        var monthId = item.BudgetCategory.BudgetMonthId;
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == monthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
