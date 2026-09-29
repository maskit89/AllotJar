namespace AllotJar.Application.Budgets.Dtos;

public class BudgetMonthDto
{
    public Guid Id { get; set; }
    public string Key { get; set; } = string.Empty;
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>ISO 4217 code the whole budget is planned in (e.g. "EUR").</summary>
    public string BaseCurrency { get; set; } = "EUR";

    public decimal TotalIncome { get; set; }
    public decimal TotalPlanned { get; set; }

    /// <summary>Total income minus every planned amount. The banner drives this to €0.00.</summary>
    public decimal RemainingToBudget { get; set; }
    public bool IsBalanced { get; set; }

    /// <summary>
    /// How many of this month's transactions are in another currency and still wait for their
    /// budget-currency amount. Those rows are EXCLUDED from every actual on this DTO, so a non-zero count means the aggregates are
    /// incomplete — the client surfaces it rather than presenting face-value money as real.
    /// </summary>
    public int FxPendingCount { get; set; }

    public List<BudgetCategoryDto> Categories { get; set; } = new();
}

public class BudgetCategoryDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>"Income", "Expense" or "Savings" — drives where/how the group renders.</summary>
    public string Kind { get; set; } = "Expense";

    public int DisplayOrder { get; set; }
    public decimal TotalPlanned { get; set; }
    public decimal TotalActual { get; set; }

    /// <summary>
    /// True for allocation-OUTPUT categories (pocket money, personal savings): they count
    /// into the budget's planned total (so "zero" includes them) but the allocation engine
    /// leaves them out of its shared-obligation envelopes to avoid a double deduction.
    /// </summary>
    public bool ExcludeFromAllocation { get; set; }

    public List<BudgetItemDto> Items { get; set; } = new();
}

public class BudgetItemDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public int DisplayOrder { get; set; }
    public decimal PlannedAmount { get; set; }
    public decimal ActualAmount { get; set; }
    public decimal Remaining { get; set; }

    /// <summary>
    /// Refunds received against this expense/savings line (rules 38/39), already subtracted from
    /// <see cref="ActualAmount"/>; 0 on income lines. Lets the line say "80.00 after 20.00 refunded".
    /// </summary>
    public decimal RefundedAmount { get; set; }

    /// <summary>The sinking-fund identity for a fund line; null for ordinary lines.</summary>
    public Guid? SavingsId { get; set; }

    /// <summary>
    /// For a fund line, the running available balance (rolled over from prior months);
    /// null for non-fund lines.
    /// </summary>
    public decimal? SavingsAvailable { get; set; }

    /// <summary>Rule 60 (W04): a jar line whose contribution the user skipped this month; it stands at 0 and the jar's other months carry the plan.</summary>
    public bool IsSkipped { get; set; }

    /// <summary>The day of the month (1–31) this bill is due; null when it isn't a bill.</summary>
    public int? DueDay { get; set; }

    /// <summary>Whether this month's instance of the bill has been paid.</summary>
    public bool IsPaid { get; set; }

    /// <summary>
    /// The household member this income line is attributed to (who earns it);
    /// null = whole-household. Always null on expense/savings lines.
    /// </summary>
    public Guid? MemberId { get; set; }
}
