using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Domain.Enums;

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

        // Accumulate each spending category's actuals across the year, keyed by
        // (name, kind) since the category entities are per-month, not stable ids.
        var categoryTotals = new Dictionary<(string Name, CategoryKind Kind), decimal>();
        var budgetedMonths = 0;

        var result = new AnnualSummaryDto { Year = request.Year };
        for (var month = 1; month <= 12; month++)
        {
            var entry = new AnnualMonthDto
            {
                Month = month,
                Key = $"{request.Year:D4}-{month:D2}",
                HasBudget = false,
            };

            if (byMonth.TryGetValue(month, out var budget))
            {
                await BudgetActuals.ApplyAsync(_db, userId, budget, cancellationToken);
                entry.HasBudget = true;
                budgetedMonths++;
                entry.Income = budget.TotalIncome;
                entry.Planned = budget.TotalPlanned;
                entry.Spent = budget.Categories
                    .Where(c => c.Kind != CategoryKind.Income)
                    .Sum(c => c.TotalActual);

                foreach (var category in budget.Categories.Where(c => c.Kind != CategoryKind.Income))
                {
                    var key = (category.Name, category.Kind);
                    categoryTotals[key] = categoryTotals.GetValueOrDefault(key) + category.TotalActual;
                }
            }

            result.Months.Add(entry);
        }

        result.TotalIncome = result.Months.Sum(m => m.Income);
        result.TotalPlanned = result.Months.Sum(m => m.Planned);
        result.TotalSpent = result.Months.Sum(m => m.Spent);
        result.BudgetedMonths = budgetedMonths;

        result.Categories = categoryTotals
            .Where(kvp => kvp.Value != 0m)
            .Select(kvp => new AnnualCategoryDto
            {
                Name = kvp.Key.Name,
                Kind = kvp.Key.Kind.ToString(),
                Total = kvp.Value,
                AveragePerMonth = budgetedMonths == 0
                    ? 0m
                    : Math.Round(kvp.Value / budgetedMonths, 2, MidpointRounding.AwayFromZero),
            })
            .OrderByDescending(c => c.AveragePerMonth)
            .ToList();

        return result;
    }
}
