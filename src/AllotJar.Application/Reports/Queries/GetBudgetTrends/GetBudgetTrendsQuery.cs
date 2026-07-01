using MediatR;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetBudgetTrends;

/// <summary>
/// Rolls up the user's most recent <paramref name="Months"/> budgets into a
/// chronological income / planned / spent series for the reports page.
/// </summary>
public record GetBudgetTrendsQuery(int Months = 6) : IRequest<BudgetTrendsDto>;
