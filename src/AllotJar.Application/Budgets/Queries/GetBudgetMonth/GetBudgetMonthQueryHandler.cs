using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Queries.GetBudgetMonth;

public class GetBudgetMonthQueryHandler : IRequestHandler<GetBudgetMonthQuery, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly TimeProvider _clock;

    public GetBudgetMonthQueryHandler(IApplicationDbContext db, ICurrentUser currentUser, TimeProvider? clock = null)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock ?? TimeProvider.System;
    }

    public async Task<BudgetMonthDto> Handle(GetBudgetMonthQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Ownership is enforced in the query itself: the OwnerId predicate means a
        // user can never project another user's budget, regardless of the month asked for.
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstOrDefaultAsync(
                m => m.OwnerId == userId
                     && m.Year == request.Year
                     && m.Month == request.Month,
                cancellationToken);

        if (month is null)
        {
            throw new NotFoundException(
                $"No budget found for {request.Year:D4}-{request.Month:D2}.");
        }

        // Roll actual spending up from assigned transactions.
        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken,
            today: DateOnly.FromDateTime(_clock.GetUtcNow().UtcDateTime));

        return month.ToDto();
    }
}
