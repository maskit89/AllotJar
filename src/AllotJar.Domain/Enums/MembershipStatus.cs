namespace AllotJar.Domain.Enums;

/// <summary>
/// Lifecycle of a <see cref="Entities.HouseholdMembership"/>.
///   <see cref="Active"/>  — the login exists and can sign in.
///   <see cref="Invited"/> — an invite link has been issued but not yet redeemed;
///                           there is no login user behind it yet.
/// </summary>
public enum MembershipStatus
{
    Active = 0,
    Invited = 1,
}
