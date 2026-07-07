using MediatR;

namespace AllotJar.Application.Budgets.Queries.GetBudgetMonths;

/// <summary>Lists the months the user has a budget for (lightweight, for the navigator).</summary>
public record GetBudgetMonthsQuery : IRequest<IReadOnlyList<BudgetMonthSummaryDto>>;

public class BudgetMonthSummaryDto
{
    public int Year { get; set; }
    public int Month { get; set; }
    public string Key { get; set; } = string.Empty;
}
