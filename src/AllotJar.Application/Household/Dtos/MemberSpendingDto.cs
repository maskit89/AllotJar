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

    /// <summary>Total expense attributed to this member across all of their transactions and slices.</summary>
    public decimal Spent { get; set; }
}
