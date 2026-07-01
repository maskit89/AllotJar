namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// A whole calendar year at a glance: one entry per month (Jan–Dec, including
/// months with no budget) plus year totals. Income/Planned are budgeted amounts;
/// Spent is the derived actual spending.
/// </summary>
public class AnnualSummaryDto
{
    public int Year { get; set; }

    /// <summary>Always 12 entries, January → December.</summary>
    public List<AnnualMonthDto> Months { get; set; } = new();

    public decimal TotalIncome { get; set; }
    public decimal TotalPlanned { get; set; }
    public decimal TotalSpent { get; set; }

    /// <summary>How many of the 12 months actually have a budget — the denominator for the per-category averages.</summary>
    public int BudgetedMonths { get; set; }

    /// <summary>
    /// Per-category spending across the year (non-income groups, grouped by name),
    /// each with its yearly total and average per budgeted month. Mirrors the
    /// workbook's per-row <c>=AVERAGE(...)</c> column. Biggest average first.
    /// </summary>
    public List<AnnualCategoryDto> Categories { get; set; } = new();
}

/// <summary>One spending category's full-year total and its average per budgeted month.</summary>
public class AnnualCategoryDto
{
    public string Name { get; set; } = string.Empty;

    /// <summary>"Expense" or "Savings".</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Total actual spending for this category across the year.</summary>
    public decimal Total { get; set; }

    /// <summary>Total ÷ number of budgeted months (0 when no budgeted months).</summary>
    public decimal AveragePerMonth { get; set; }
}

public class AnnualMonthDto
{
    public int Month { get; set; }

    /// <summary>"2026-06".</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>False for months the user hasn't created a budget for.</summary>
    public bool HasBudget { get; set; }

    public decimal Income { get; set; }
    public decimal Planned { get; set; }
    public decimal Spent { get; set; }
}
