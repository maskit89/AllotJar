using AllotJar.Domain.Common;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A person in the household (e.g. Alex, Sam). Members are first-class entities under
/// the single household <see cref="OwnerId"/> — they are NOT separate login accounts.
/// Each carries the net monthly income and personal savings destination the income
/// allocation engine needs to fund shared costs and split the surplus.
/// </summary>
public class HouseholdMember : BaseEntity
{
    /// <summary>Identity user id that owns the household this member belongs to.</summary>
    public string OwnerId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// The saved "Default income": the income line this person gets when a blank month is
    /// created (rule 28). Never a figure any calculation reads — the month's budget lines are.
    /// In the household base currency; mapped to decimal(18,4).
    /// </summary>
    public decimal NetMonthlyIncome { get; set; }

    /// <summary>
    /// The account this member's allocated surplus lands in, if set. A soft hint (no FK,
    /// like a fund's funding account) so members and accounts stay independently managed.
    /// </summary>
    public Guid? PersonalSavingsAccountId { get; set; }

    public int DisplayOrder { get; set; }

    /// <summary>Archived members are hidden and excluded from allocation, but kept for history.</summary>
    public bool IsArchived { get; set; }
}
