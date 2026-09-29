namespace AllotJar.Application.Household.Dtos;

/// <summary>Per-member income for a month, derived from the budget's attributed lines.</summary>
public class MemberIncomeResultDto
{
    /// <summary>Always true since rule 28: every figure here comes from the month's budget. Kept for older clients.</summary>
    public bool IncomeFromBudget { get; set; }

    /// <summary>False when the month has no budget yet (planned figures are then zero).</summary>
    public bool HasBudget { get; set; }

    /// <summary>Income transactions in the month still waiting for their budget-currency amount; they are left out of Received until the user enters it.</summary>
    public int FxPendingCount { get; set; }

    /// <summary>Planned income not attributed to any active person (whole-household).</summary>
    public decimal UnattributedPlanned { get; set; }

    public IReadOnlyList<MemberIncomeDto> Items { get; set; } = Array.Empty<MemberIncomeDto>();
}

public class MemberIncomeDto
{
    public Guid MemberId { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>The month's income lines attributed to this person (planned amounts).</summary>
    public decimal Planned { get; set; }

    /// <summary>Income transactions (whole + slices) attributed to this person, dated in the month, in the budget currency; rows still waiting for a budget-currency amount are left out.</summary>
    public decimal Received { get; set; }

    /// <summary>This person's month income the way the allocation sees it: attributed lines plus an equal share of the unattributed ones.</summary>
    public decimal Income { get; set; }

    /// <summary>This person's share of the household's month income (0–1).</summary>
    public decimal SharePct { get; set; }
}
