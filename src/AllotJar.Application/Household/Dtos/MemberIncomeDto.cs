namespace AllotJar.Application.Household.Dtos;

/// <summary>Per-member income for a month, derived from the budget's attributed lines.</summary>
public class MemberIncomeResultDto
{
    /// <summary>True when the month's budget attributes income to at least one person.</summary>
    public bool IncomeFromBudget { get; set; }

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

    /// <summary>Income transactions (whole + slices) attributed to this person, dated in the month.</summary>
    public decimal Received { get; set; }
}
