namespace AllotJar.Domain.Entities;

/// <summary>
/// One login that has been linked to a budget person (S-P3-8, D5). A row is kept for every login
/// ever linked to the person, not only the current one, so re-linking people can never hand a
/// person's "own login" to whoever was linked last. While any other such login is still in the
/// household and has not released its link, no login may make the person's accounts private
/// (P54: only the person's own login may).
/// <para>
/// Only the login itself can release its link ("This isn't me"), never the owner, and a
/// login that leaves or is removed from the household stops counting while it is gone.
/// </para>
/// </summary>
public class PersonLogin
{
    /// <summary>The budget person (<see cref="HouseholdMember"/>) the login was linked to.</summary>
    public Guid HouseholdMemberId { get; set; }

    /// <summary>The identity user id of the login.</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>When the login was (last) linked to the person.</summary>
    public DateTime LinkedUtc { get; set; } = DateTime.UtcNow;

    /// <summary>When the login said it isn't this person; null while the link still counts.</summary>
    public DateTime? ReleasedUtc { get; set; }
}
