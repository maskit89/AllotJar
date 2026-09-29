namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// One calendar month as the reports read it (rules 37–39, 41). Two layers add up: what the
/// month's budget lines derive (planned and actual, net of the refunds assigned to them) and what
/// no line carries yet — uncategorised income and spending, and refunds left unplaced — counted
/// by the transaction's own date. So the month's total is the same before and after a
/// transaction is categorised (rule 37), a refund reduces spending in the month it was received
/// (rule 39), and received income is every income row of the month except transfers and refunds
/// (rule 41). Months without a budget still carry the transaction-derived layer.
/// </summary>
public class MonthReportDto
{
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>"2026-06".</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>False for months the user hasn't created a budget for.</summary>
    public bool HasBudget { get; set; }

    /// <summary>The budget's base currency; null when the month has no budget.</summary>
    public string? BaseCurrency { get; set; }

    /// <summary>Budgeted (planned) income: Σ income lines' planned amounts.</summary>
    public decimal IncomeBudgeted { get; set; }

    /// <summary>
    /// Income actually received in the month (rule 41): income lines' actuals plus income rows no
    /// line carries; never a transfer, never a refund.
    /// </summary>
    public decimal IncomeReceived { get; set; }

    /// <summary>The part of <see cref="IncomeReceived"/> that no income line carries yet.</summary>
    public decimal IncomeUncategorised { get; set; }

    /// <summary>Received − budgeted income, signed (negative when less came in than planned). Rule 41.</summary>
    public decimal Variance { get; set; }

    /// <summary>Budgeted spending: Σ expense and savings lines' planned amounts.</summary>
    public decimal Planned { get; set; }

    /// <summary>Spending on the month's expense and savings lines, net of the refunds assigned to them.</summary>
    public decimal SpentCategorised { get; set; }

    /// <summary>
    /// Spending no line carries yet (rule 37): expenses dated in the month with no line and no
    /// split, plus unassigned slices, less refunds received in the month that are not on a line.
    /// </summary>
    public decimal SpentUncategorised { get; set; }

    /// <summary>Every refund received in the month (rules 38/39), on a line or not; already netted out of the spending figures.</summary>
    public decimal Refunds { get; set; }

    /// <summary>Net spending for the month: <see cref="SpentCategorised"/> + <see cref="SpentUncategorised"/>.</summary>
    public decimal Spent { get; set; }

    /// <summary>Expense rows and refunds dated in the month that still need a line (flagged for review, rule 37).</summary>
    public int UncategorisedCount { get; set; }

    /// <summary>Income rows dated in the month that still need a line.</summary>
    public int UncategorisedIncomeCount { get; set; }

    /// <summary>Rows in the month still waiting for a budget-currency amount; they are left out of every figure above.</summary>
    public int FxPendingCount { get; set; }

    /// <summary>
    /// Spending by group: the budget's expense and savings groups in display order, then an
    /// <c>Uncategorised</c> row when anything is unplaced. Empty groups are included so a month
    /// with refunds only still explains itself.
    /// </summary>
    public List<MonthReportCategoryDto> Categories { get; set; } = new();
}

/// <summary>One spending group of a month, gross and net of the refunds received against it.</summary>
public class MonthReportCategoryDto
{
    /// <summary>The budget category's id; null for the Uncategorised row.</summary>
    public Guid? Id { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>"Expense", "Savings" or "Uncategorised".</summary>
    public string Kind { get; set; } = string.Empty;

    /// <summary>Position among the month's non-income groups (so a colour can match the Budget screen); -1 for Uncategorised.</summary>
    public int Index { get; set; }

    /// <summary>What went out, before refunds.</summary>
    public decimal Spent { get; set; }

    /// <summary>Refunds received in the month against this group.</summary>
    public decimal Refunds { get; set; }

    /// <summary><see cref="Spent"/> − <see cref="Refunds"/>; can be negative when more came back than went out this month.</summary>
    public decimal Net { get; set; }

    public bool IsUncategorised { get; set; }

    /// <summary>For the Uncategorised row: how many rows need a line.</summary>
    public int Count { get; set; }
}
