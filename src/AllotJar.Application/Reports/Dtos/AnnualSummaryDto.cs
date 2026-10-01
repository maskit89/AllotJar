namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// A whole calendar year at a glance: one entry per month (Jan–Dec, including months with no
/// budget) plus year totals. Income/Planned are budgeted amounts; IncomeReceived and Spent are
/// derived from what happened, by the rules of <see cref="MonthReportDto"/>: spending includes
/// uncategorised rows and is net of refunds; received income leaves out transfers and refunds
/// (rules 37–39, 41). A month without a budget still carries its transaction-derived figures.
/// </summary>
public class AnnualSummaryDto
{
    public int Year { get; set; }

    /// <summary>Always 12 entries, January → December.</summary>
    public List<AnnualMonthDto> Months { get; set; } = new();

    /// <summary>Σ budgeted income.</summary>
    public decimal TotalIncome { get; set; }

    /// <summary>Σ income actually received (rule 41).</summary>
    public decimal TotalIncomeReceived { get; set; }

    /// <summary>Σ (received − budgeted), signed.</summary>
    public decimal TotalVariance { get; set; }

    public decimal TotalPlanned { get; set; }

    /// <summary>Σ net spending.</summary>
    public decimal TotalSpent { get; set; }

    /// <summary>Σ refunds received across the year (already netted out of TotalSpent).</summary>
    public decimal TotalRefunds { get; set; }

    /// <summary>How many of the 12 months actually have a budget.</summary>
    public int BudgetedMonths { get; set; }

    /// <summary>
    /// The calendar months the per-category averages divide by (D12): from the year's first month
    /// with a budget or a figure up to the current UTC month (December for a past year), or up to
    /// a later month that already has one. A month in that span with no budget counts, as zero.
    /// </summary>
    public int CountedMonths { get; set; }

    /// <summary>
    /// Per-category net spending across the year (non-income groups, grouped by name), each
    /// with its yearly total and average per counted calendar month, plus an Uncategorised entry when
    /// anything is unplaced (rule 37). Mirrors the workbook's per-row <c>=AVERAGE(...)</c>
    /// column. Biggest average first.
    /// </summary>
    public List<AnnualCategoryDto> Categories { get; set; } = new();
}

/// <summary>One spending category's full-year total and its average per counted calendar month.</summary>
public class AnnualCategoryDto
{
    public string Name { get; set; } = string.Empty;

    /// <summary>"Expense", "Savings" or "Uncategorised".</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Total net spending for this category across the year (refunds already subtracted).</summary>
    public decimal Total { get; set; }

    /// <summary>Refunds received against this category across the year.</summary>
    public decimal Refunds { get; set; }

    /// <summary>Total ÷ <see cref="AnnualSummaryDto.CountedMonths"/> (0 when none).</summary>
    public decimal AveragePerMonth { get; set; }
}

public class AnnualMonthDto
{
    public int Month { get; set; }

    /// <summary>"2026-06".</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>False for months the user hasn't created a budget for.</summary>
    public bool HasBudget { get; set; }

    /// <summary>Budgeted income.</summary>
    public decimal Income { get; set; }

    /// <summary>Income actually received (rule 41).</summary>
    public decimal IncomeReceived { get; set; }

    /// <summary>Received − budgeted, signed.</summary>
    public decimal Variance { get; set; }

    public decimal Planned { get; set; }

    /// <summary>Net spending (rules 37–39).</summary>
    public decimal Spent { get; set; }

    /// <summary>Spending no line carries yet.</summary>
    public decimal SpentUncategorised { get; set; }

    /// <summary>Refunds received in the month.</summary>
    public decimal Refunds { get; set; }

    /// <summary>Expense rows and refunds still needing a line.</summary>
    public int UncategorisedCount { get; set; }
}
