using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetBudgetMonth;

/// <summary>
/// Fetches the authenticated user's budget for the given year/month,
/// including all categories and line items plus the computed ZBB metrics.
/// </summary>
public record GetBudgetMonthQuery(int Year, int Month) : IRequest<BudgetMonthDto>;
