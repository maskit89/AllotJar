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

    /// <summary>Total expense attributed to this member (whole transactions and slices) in the budget's base currency, over the requested month or all time; rows with a pending exchange rate are left out.</summary>
    public decimal Spent { get; set; }

    /// <summary>Attributed expense rows whose exchange rate is still unresolved and therefore not counted.</summary>
    public int FxPendingCount { get; set; }
}
