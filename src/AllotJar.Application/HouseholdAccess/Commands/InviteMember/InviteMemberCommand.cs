using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.InviteMember;

/// <summary>
/// Adds a login to the household at a given role. With <see cref="InviteMethod.Direct"/> the
/// owner sets a temporary password and the account is active at once; with
/// <see cref="InviteMethod.Link"/> a one-time token is issued for the invitee to redeem.
/// Owner-only.
/// </summary>
[OwnerOnly]
public record InviteMemberCommand(
    string Email,
    HouseholdRole Role,
    InviteMethod Method,
    string? TempPassword = null,
    string? DisplayName = null,
    Guid? MemberId = null) : IRequest<InviteResultDto>;
