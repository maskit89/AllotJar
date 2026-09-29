namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// A multi-month rollup for the reports page: one point per budgeted month (chronological)
/// plus window totals. Income/Planned come from the budgeted amounts; IncomeReceived and Spent
/// are derived from what actually happened, by the rules of <see cref="MonthReportDto"/>: spending
/// includes what no line carries yet and is net of refunds; received income leaves out transfers
/// and refunds (rules 37–39, 41).
/// </summary>
public class BudgetTrendsDto
{
    public List<BudgetTrendPointDto> Points { get; set; } = new();

    /// <summary>Σ budgeted income across the window.</summary>
    public decimal TotalIncome { get; set; }

    /// <summary>Σ actually-received income across the window.</summary>
    public decimal TotalIncomeReceived { get; set; }

    /// <summary>Σ (received − budgeted) across the window, signed.</summary>
    public decimal TotalVariance { get; set; }

    /// <summary>Σ net spending across the window.</summary>
    public decimal TotalSpent { get; set; }

    /// <summary>Σ spending that no line carries yet across the window.</summary>
    public decimal TotalSpentUncategorised { get; set; }

    /// <summary>Σ refunds received across the window (already netted out of TotalSpent).</summary>
    public decimal TotalRefunds { get; set; }
}

public class BudgetTrendPointDto
{
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>"2026-06".</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>Budgeted income for the month (Σ income-group planned lines).</summary>
    public decimal Income { get; set; }

    /// <summary>Income actually received in the month: income lines' actuals plus uncategorised income; never transfers or refunds (rule 41).</summary>
    public decimal IncomeReceived { get; set; }

    /// <summary>The part of <see cref="IncomeReceived"/> no income line carries yet.</summary>
    public decimal IncomeUncategorised { get; set; }

    /// <summary>Received − budgeted income, signed (rule 41).</summary>
    public decimal Variance { get; set; }

    /// <summary>Budgeted spending for the month (Σ non-income planned lines).</summary>
    public decimal Planned { get; set; }

    /// <summary>Net spending for the month: categorised and uncategorised, less refunds (rules 37–39).</summary>
    public decimal Spent { get; set; }

    /// <summary>Spending on the month's lines, net of the refunds assigned to them.</summary>
    public decimal SpentCategorised { get; set; }

    /// <summary>Spending no line carries yet, less unplaced refunds (rule 37).</summary>
    public decimal SpentUncategorised { get; set; }

    /// <summary>Every refund received in the month (rules 38/39).</summary>
    public decimal Refunds { get; set; }

    /// <summary>Expense rows and refunds still needing a line (flagged for review).</summary>
    public int UncategorisedCount { get; set; }

    /// <summary>Rows still waiting for a budget-currency amount, left out of the figures.</summary>
    public int FxPendingCount { get; set; }
}
