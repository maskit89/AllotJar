namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// A multi-month rollup for the reports page: one point per month (chronological)
/// plus window totals. Income/Planned come from the budgeted amounts; Spent is the
/// derived actual spending (so the user can compare what they planned vs what went out).
/// </summary>
public class BudgetTrendsDto
{
    public List<BudgetTrendPointDto> Points { get; set; } = new();

    /// <summary>Σ budgeted income across the window.</summary>
    public decimal TotalIncome { get; set; }

    /// <summary>Σ actually-received income across the window.</summary>
    public decimal TotalIncomeReceived { get; set; }

    /// <summary>Σ actual spending across the window.</summary>
    public decimal TotalSpent { get; set; }
}

public class BudgetTrendPointDto
{
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>"2026-06".</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>Budgeted income for the month (Σ income-group planned lines).</summary>
    public decimal Income { get; set; }

    /// <summary>Actually-received income for the month (Σ income-group actuals).</summary>
    public decimal IncomeReceived { get; set; }

    /// <summary>Budgeted spending for the month (Σ non-income planned lines).</summary>
    public decimal Planned { get; set; }

    /// <summary>Actual spending for the month (Σ non-income actuals).</summary>
    public decimal Spent { get; set; }
}
