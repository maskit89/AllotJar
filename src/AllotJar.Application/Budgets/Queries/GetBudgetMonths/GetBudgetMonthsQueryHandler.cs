using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Queries.GetBudgetMonths;

public class GetBudgetMonthsQueryHandler
    : IRequestHandler<GetBudgetMonthsQuery, IReadOnlyList<BudgetMonthSummaryDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetBudgetMonthsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<BudgetMonthSummaryDto>> Handle(
        GetBudgetMonthsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var months = await _db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == userId)
            .OrderByDescending(m => m.Year)
                .ThenByDescending(m => m.Month)
            .Select(m => new { m.Year, m.Month })
            .ToListAsync(cancellationToken);

        return months
            .Select(m => new BudgetMonthSummaryDto
            {
                Year = m.Year,
                Month = m.Month,
                Key = $"{m.Year:D4}-{m.Month:D2}",
            })
            .ToList();
    }
}
