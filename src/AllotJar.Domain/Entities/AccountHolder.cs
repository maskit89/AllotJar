namespace AllotJar.Domain.Entities;

/// <summary>
/// A person (<see cref="HouseholdMember"/>) who holds an <see cref="Account"/> (rule 30). An account
/// with one holder is personal, with several it is joint, and with none it is the household's own.
/// However many hold it, the account keeps one balance and one history: holders are who it belongs
/// to, never a copy of its money. There are no ownership shares (P52).
/// </summary>
public class AccountHolder
{
    public Guid AccountId { get; set; }
    public Account? Account { get; set; }

    public Guid MemberId { get; set; }
    public HouseholdMember? Member { get; set; }
}
