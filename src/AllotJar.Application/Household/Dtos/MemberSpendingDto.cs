namespace AllotJar.Application.Household.Dtos;

/// <summary>
/// One active member's attributed spending — the "who spent what" lens over
/// transactions tagged to a member (whole-transaction attribution) plus the
/// per-member slices of split transactions (the workbook's Visa-style sharing).
/// </summary>
public class MemberSpendingDto
{
    public Guid MemberId { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>Total expense attributed to this member (whole transactions and slices) in the budget currency, over the requested month or all time; rows still waiting for a budget-currency amount are left out.</summary>
    public decimal Spent { get; set; }

    /// <summary>Attributed expense rows still waiting for their budget-currency amount and therefore not counted.</summary>
    public int FxPendingCount { get; set; }
}
