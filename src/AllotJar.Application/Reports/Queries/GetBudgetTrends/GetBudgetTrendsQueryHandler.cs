using MediatR;
using Microsoft.EntityFrameworkCore;
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

        // The last `window` calendar months up to the latest budget, none before the first month
        // with a budget or a recorded row. A month with no budget is still a month: it reports its
        // transactions and counts in the window as the annual table counts it (P21; D12, review
        // RP-P3-2).
        var budgeted = await _db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == userId)
            .Select(m => m.Year * 12 + m.Month - 1)
            .ToListAsync(cancellationToken);
        if (budgeted.Count == 0)
        {
            return new BudgetTrendsDto();
        }
        var firstRow = await _db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId && t.Type != TransactionType.Transfer)
            .MinAsync(t => (DateOnly?)t.Date, cancellationToken);
        var end = budgeted.Max();
        var began = firstRow is DateOnly date ? Math.Min(budgeted.Min(), date.Year * 12 + date.Month - 1) : budgeted.Min();
        var start = Math.Max(end - window + 1, began);
        var calendar = Enumerable.Range(start, end - start + 1)
            .Select(i => (Year: i / 12, Month: i % 12 + 1))
            .ToList();
        var first = calendar[0];

        var months = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId
                        && (m.Year > first.Year || (m.Year == first.Year && m.Month >= first.Month)))
            .ToListAsync(cancellationToken);
        var byMonth = months.ToDictionary(m => (m.Year, m.Month));

        var points = new List<BudgetTrendPointDto>();
        foreach (var (year, month) in calendar)
        {
            byMonth.TryGetValue((year, month), out var budget);
            // One derivation for every report (rules 37–39, 41): spending includes uncategorised
            // rows and is net of refunds; received income leaves out transfers and refunds.
            var figures = await ReportFigures.ForMonthAsync(_db, userId, year, month, budget, cancellationToken);

            points.Add(new BudgetTrendPointDto
            {
                Year = year,
                Month = month,
                Key = figures.Key,
                HasBudget = figures.HasBudget,
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
