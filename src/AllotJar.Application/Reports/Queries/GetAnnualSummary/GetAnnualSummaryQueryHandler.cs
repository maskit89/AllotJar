using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetAnnualSummary;

public class GetAnnualSummaryQueryHandler : IRequestHandler<GetAnnualSummaryQuery, AnnualSummaryDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetAnnualSummaryQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AnnualSummaryDto> Handle(GetAnnualSummaryQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var months = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == userId && m.Year == request.Year)
            .ToListAsync(cancellationToken);

        var byMonth = months.ToDictionary(m => m.Month);

        // Accumulate each spending group's net actuals and refunds across the year, keyed by
        // (name, kind) since the category entities are per-month, not stable ids. The
        // Uncategorised row accumulates under its own key (rule 37).
        var categoryTotals = new Dictionary<(string Name, string Kind), (decimal Net, decimal Refunds)>();
        var budgetedMonths = 0;

        var result = new AnnualSummaryDto { Year = request.Year };
        for (var month = 1; month <= 12; month++)
        {
            byMonth.TryGetValue(month, out var budget);
            // One derivation for every report (rules 37–39, 41). A month with no budget still
            // reports what its transactions say.
            var figures = await ReportFigures.ForMonthAsync(_db, userId, request.Year, month, budget, cancellationToken);
            if (figures.HasBudget)
            {
                budgetedMonths++;
            }

            result.Months.Add(new AnnualMonthDto
            {
                Month = month,
                Key = figures.Key,
                HasBudget = figures.HasBudget,
                Income = figures.IncomeBudgeted,
                IncomeReceived = figures.IncomeReceived,
                Variance = figures.Variance,
                Planned = figures.Planned,
                Spent = figures.Spent,
                SpentUncategorised = figures.SpentUncategorised,
                Refunds = figures.Refunds,
                UncategorisedCount = figures.UncategorisedCount,
            });

            foreach (var category in figures.Categories)
            {
                var key = (category.Name, category.Kind);
                var current = categoryTotals.GetValueOrDefault(key);
                categoryTotals[key] = (current.Net + category.Net, current.Refunds + category.Refunds);
            }
        }

        result.TotalIncome = result.Months.Sum(m => m.Income);
        result.TotalIncomeReceived = result.Months.Sum(m => m.IncomeReceived);
        result.TotalVariance = result.Months.Sum(m => m.Variance);
        result.TotalPlanned = result.Months.Sum(m => m.Planned);
        result.TotalSpent = result.Months.Sum(m => m.Spent);
        result.TotalRefunds = result.Months.Sum(m => m.Refunds);
        result.BudgetedMonths = budgetedMonths;

        result.Categories = categoryTotals
            .Where(kvp => kvp.Value.Net != 0m || kvp.Value.Refunds != 0m)
            .Select(kvp => new AnnualCategoryDto
            {
                Name = kvp.Key.Name,
                Kind = kvp.Key.Kind,
                Total = kvp.Value.Net,
                Refunds = kvp.Value.Refunds,
                AveragePerMonth = budgetedMonths == 0
                    ? 0m
                    : Math.Round(kvp.Value.Net / budgetedMonths, 2, MidpointRounding.AwayFromZero),
            })
            .OrderByDescending(c => c.AveragePerMonth)
            .ToList();

        return result;
    }
}
