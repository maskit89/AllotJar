using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Domain.Enums;

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
            // Derive spending actuals the same way every other read does.
            await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

            var spent = month.Categories
                .Where(c => c.Kind != CategoryKind.Income)
                .Sum(c => c.TotalActual);

            // Income lines roll up their assigned income transactions just like
            // expense lines roll up spending, so this is the user's actually-received
            // income for the month (vs the budgeted Income above).
            var incomeReceived = month.Categories
                .Where(c => c.Kind == CategoryKind.Income)
                .Sum(c => c.TotalActual);

            points.Add(new BudgetTrendPointDto
            {
                Year = month.Year,
                Month = month.Month,
                Key = month.Key,
                Income = month.TotalIncome,       // budgeted income
                IncomeReceived = incomeReceived,  // actually-received income
                Planned = month.TotalPlanned,     // budgeted spending
                Spent = spent,                    // actual spending
            });
        }

        return new BudgetTrendsDto
        {
            Points = points,
            TotalIncome = points.Sum(p => p.Income),
            TotalIncomeReceived = points.Sum(p => p.IncomeReceived),
            TotalSpent = points.Sum(p => p.Spent),
        };
    }
}
