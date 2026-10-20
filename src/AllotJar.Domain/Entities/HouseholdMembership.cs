using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// Grants a login (<see cref="UserId"/>) access to a household's budget (keyed by
/// <see cref="OwnerId"/>) at a given <see cref="Role"/>. This is the layer that turns the
/// single-user budget into a shared one: the creator's data is all stamped with their own
/// id as <see cref="OwnerId"/>, and additional people get a membership row pointing at that
/// same owner. NOT the same as <see cref="HouseholdMember"/> (which models income/attribution).
/// </summary>
public class HouseholdMembership : BaseEntity
{
    /// <summary>The household partition key — the creator's identity user id. All budget data carries this.</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>The member's identity user id. Null while an invite link is pending redemption.</summary>
    public string? UserId { get; set; }

    public HouseholdRole Role { get; set; }

    public MembershipStatus Status { get; set; }

    /// <summary>The email the membership/invite is for.</summary>
    public string InvitedEmail { get; set; } = string.Empty;

    [MaskCardNumbers]
    public string? DisplayName { get; set; }

    /// <summary>SHA-256 of the one-time invite token (link mode). The raw token is shown to the owner once.</summary>
    public string? InviteTokenHash { get; set; }

    public DateTime? InviteExpiresUtc { get; set; }

    /// <summary>Optional soft link to the budget-attribution member (no FK), so "who entered this" can be derived.</summary>
    public Guid? MemberId { get; set; }

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Rule 32 (P58): this login has personal accounts whose sharing it has not reviewed yet — set
    /// when the login is linked to a person who already holds accounts, or when someone else adds a
    /// personal account for that person. Cleared when the login reviews its sharing; nothing about
    /// the accounts' visibility changes until then.
    /// </summary>
    public bool SharingReviewPending { get; set; }
}
