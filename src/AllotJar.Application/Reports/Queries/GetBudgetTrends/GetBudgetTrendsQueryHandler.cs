using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetBudgetTrends;

public class GetBudgetTrendsQueryHandler : IRequestHandler<GetBudgetTrendsQuery, BudgetTrendsDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetBudgetTrendsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetTrendsDto> Handle(GetBudgetTrendsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var window = Math.Clamp(request.Months, 1, 24);

        // The most recent `window` budgets the user has.
        var recentIds = await _db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == userId)
            .OrderByDescending(m => m.Year)
                .ThenByDescending(m => m.Month)
            .Take(window)
            .Select(m => m.Id)
            .ToListAsync(cancellationToken);

        var months = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => recentIds.Contains(m.Id))
            .ToListAsync(cancellationToken);

        var points = new List<BudgetTrendPointDto>();
        foreach (var month in months.OrderBy(m => m.Year).ThenBy(m => m.Month))
        {
            // One derivation for every report (rules 37–39, 41): spending includes uncategorised
            // rows and is net of refunds; received income leaves out transfers and refunds.
            var figures = await ReportFigures.ForMonthAsync(_db, userId, month.Year, month.Month, month, cancellationToken);

            points.Add(new BudgetTrendPointDto
            {
                Year = month.Year,
                Month = month.Month,
                Key = month.Key,
                Income = figures.IncomeBudgeted,
                IncomeReceived = figures.IncomeReceived,
                IncomeUncategorised = figures.IncomeUncategorised,
                Variance = figures.Variance,
                Planned = figures.Planned,
                Spent = figures.Spent,
                SpentCategorised = figures.SpentCategorised,
                SpentUncategorised = figures.SpentUncategorised,
                Refunds = figures.Refunds,
                UncategorisedCount = figures.UncategorisedCount,
                FxPendingCount = figures.FxPendingCount,
            });
        }

        return new BudgetTrendsDto
        {
            Points = points,
            TotalIncome = points.Sum(p => p.Income),
            TotalIncomeReceived = points.Sum(p => p.IncomeReceived),
            TotalVariance = points.Sum(p => p.Variance),
            TotalSpent = points.Sum(p => p.Spent),
            TotalSpentUncategorised = points.Sum(p => p.SpentUncategorised),
            TotalRefunds = points.Sum(p => p.Refunds),
        };
    }
}
