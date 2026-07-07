using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using AllotJar.Api.Features;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;
using AllotJar.Application.HouseholdAccess.Commands.InviteMember;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Application.HouseholdAccess.Queries.GetMemberships;
using AllotJar.Domain.Enums;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Manages the logins that share a household's budget and their access levels. Listing is open
/// to any member; mutating actions are reserved for the Owner by the [OwnerOnly] commands they
/// dispatch (enforced in the MediatR authorization pipeline).
/// </summary>
[ApiController]
[Authorize]
[FeatureGate(nameof(FeatureFlags.HouseholdAccess))]
[Route("api/access")]
public class HouseholdAccessController : ControllerBase
{
    private readonly ISender _mediator;

    public HouseholdAccessController(ISender mediator)
    {
        _mediator = mediator;
    }

    /// <summary>Lists the logins with access to the household.</summary>
    [HttpGet("members")]
    [ProducesResponseType(typeof(IReadOnlyList<MembershipDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MembershipDto>>> List(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMembershipsQuery(), ct);
        return Ok(result);
    }

    /// <summary>Invites a person (direct temp password or one-time link). Owner-only.</summary>
    /// <remarks>Rate-limited: direct invites mint logins, so cap the pace like the auth endpoints.</remarks>
    [HttpPost("invite")]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(InviteResultDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<ActionResult<InviteResultDto>> Invite(InviteMemberRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new InviteMemberCommand(
            request.Email, request.Role, request.Method,
            request.TempPassword, request.DisplayName, request.MemberId), ct);
        return Ok(result);
    }

    /// <summary>Changes a member's access level. Owner-only.</summary>
    [HttpPut("members/{id:guid}/role")]
    [ProducesResponseType(typeof(MembershipDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MembershipDto>> ChangeRole(Guid id, ChangeRoleRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new ChangeMemberRoleCommand(id, request.Role), ct);
        return Ok(result);
    }

    /// <summary>Links a login to the budget person it represents, or unlinks it (null member). Owner-only.</summary>
    [HttpPut("members/{id:guid}/link")]
    [ProducesResponseType(typeof(MembershipDto), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<ActionResult<MembershipDto>> Link(Guid id, LinkMemberRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new LinkMembershipMemberCommand(id, request.MemberId), ct);
        return Ok(result);
    }

    /// <summary>Removes a member's access to the household. Owner-only.</summary>
    [HttpDelete("members/{id:guid}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Revoke(Guid id, CancellationToken ct)
    {
        await _mediator.Send(new RevokeMemberCommand(id), ct);
        return NoContent();
    }
}

/// <summary>Request body for inviting a household member.</summary>
public record InviteMemberRequest(
    string Email,
    HouseholdRole Role,
    InviteMethod Method,
    string? TempPassword,
    string? DisplayName,
    Guid? MemberId);

/// <summary>Request body for changing a member's role (the id comes from the route).</summary>
public record ChangeRoleRequest(HouseholdRole Role);

/// <summary>Request body for linking a login to a budget person (null member = unlink).</summary>
public record LinkMemberRequest(Guid? MemberId);
