namespace AllotJar.Application.HouseholdAccess;

/// <summary>How the owner is adding a login when inviting a household member.</summary>
public enum InviteMethod
{
    /// <summary>Owner sets a temporary password now; the account is active immediately.</summary>
    Direct = 0,

    /// <summary>A one-time link is issued; the invitee redeems it and sets their own password.</summary>
    Link = 1,
}
