using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Dtos;

/// <summary>A login's access within the household, as shown on the access page.</summary>
public record MembershipDto(
    Guid Id,
    string Email,
    string? DisplayName,
    HouseholdRole Role,
    MembershipStatus Status,
    Guid? MemberId,
    bool IsOwner,
    bool IsSelf,
    DateTime CreatedUtc);

/// <summary>
/// Returned by an invite: the new membership and, for link invites, the raw token, which the API
/// emails to the invited address and never returns to the inviter.
/// </summary>
public record InviteResultDto(MembershipDto Membership, string? InviteToken);

public static class MembershipMapping
{
    public static MembershipDto ToDto(this HouseholdMembership m, string? currentUserId) =>
        new(
            m.Id,
            m.InvitedEmail,
            m.DisplayName,
            m.Role,
            m.Status,
            m.MemberId,
            IsOwner: m.Role == HouseholdRole.Owner,
            IsSelf: m.UserId is not null && m.UserId == currentUserId,
            m.CreatedUtc);
}
