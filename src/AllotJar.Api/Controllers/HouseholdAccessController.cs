using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using AllotJar.Api.Features;
using AllotJar.Api.Services;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;
using AllotJar.Application.HouseholdAccess.Commands.InviteMember;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.HouseholdAccess.Commands.ReleasePersonLogin;
using AllotJar.Application.HouseholdAccess.Commands.ResendInvite;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Application.HouseholdAccess.Queries.GetMemberships;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;

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

    private readonly AccountEmails _accountEmails;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly ResendCooldown _resendCooldown;
    private readonly InviteEmailAllowance _inviteAllowance;
    private readonly ICurrentUser _currentUser;

    public HouseholdAccessController(
        ISender mediator, AccountEmails accountEmails, UserManager<ApplicationUser> userManager,
        ResendCooldown resendCooldown, InviteEmailAllowance inviteAllowance, ICurrentUser currentUser)
    {
        _mediator = mediator;
        _accountEmails = accountEmails;
        _userManager = userManager;
        _resendCooldown = resendCooldown;
        _inviteAllowance = inviteAllowance;
        _currentUser = currentUser;
    }

    /// <summary>Lists the logins with access to the household.</summary>
    [HttpGet("members")]
    [ProducesResponseType(typeof(IReadOnlyList<MembershipDto>), StatusCodes.Status200OK)]
    public async Task<ActionResult<IReadOnlyList<MembershipDto>>> List(CancellationToken ct)
    {
        var result = await _mediator.Send(new GetMembershipsQuery(), ct);
        return Ok(result);
    }

    /// <summary>
    /// Invites a person (direct temp password or one-time link). Owner-only. "Email first" (review
    /// P2-1 of #298): the invite link, or a direct-invite login's "choose your password" link, is
    /// emailed to the invited address and never returned here, so whoever invites a person never
    /// knows the password that person ends up with (P59). Outside Development an invite is refused
    /// while the server can't deliver email at all, and the response says whether the email went out
    /// (#298 R2-P2-1), so the owner is never told a link was sent when it wasn't.
    /// </summary>
    /// <remarks>Rate-limited: direct invites mint logins, so cap the pace like the auth endpoints.</remarks>
    [HttpPost("invite")]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(InviteResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<InviteResponse>> Invite(InviteMemberRequest request, CancellationToken ct)
    {
        if (!_accountEmails.CanDeliver())
        {
            return BadRequest(new { error = EmailNotSetUp });
        }
        var me = await CurrentLoginAsync();
        if (me is not { EmailConfirmed: true })
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { error = ConfirmEmailFirst });
        }
        var household = _currentUser.OwnerId ?? string.Empty;
        if (!_inviteAllowance.TryClaim(household))
        {
            return StatusCode(StatusCodes.Status429TooManyRequests, new { error = InviteEmailAllowance.Refused });
        }

        var emailSent = false;
        try
        {
            var result = await _mediator.Send(new InviteMemberCommand(
                request.Email, request.Role, request.Method,
                request.TempPassword, request.DisplayName, request.MemberId), ct);

            var email = result.Membership.Email;
            // The invite is saved either way; a failed send is reported, not hidden.
            emailSent = result.InviteToken is { } token
                ? await _accountEmails.TrySendInviteLinkAsync(email, InviterName(me), token, ct)
                : await _accountEmails.TrySendPasswordLinkAsync(email, ct) == PasswordLinkResult.Sent;
            return Ok(new InviteResponse(result.Membership, emailSent));
        }
        finally
        {
            // Only emails that went out count towards the day's allowance.
            if (!emailSent)
            {
                _inviteAllowance.Release(household);
            }
        }
    }

    /// <summary>
    /// "Send again" (#298 R2-P2-1 follow-up): emails a pending invite a fresh link (the earlier one
    /// stops working), or a login still on the temporary password someone else set its "choose your
    /// password" link, to the invited address as the invite did. Owner-only. The new invite link is
    /// saved only once its email went out, so a failed send leaves the old link working. Rate-limited per
    /// visitor and spaced a minute apart per invite, and refused like an invite while the server
    /// can't deliver email.
    /// </summary>
    [HttpPost("members/{id:guid}/resend")]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(ResendResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<ActionResult<ResendResponse>> Resend(Guid id, CancellationToken ct)
    {
        if (!_accountEmails.CanDeliver())
        {
            return BadRequest(new { error = EmailNotSetUp });
        }
        var me = await CurrentLoginAsync();
        if (me is not { EmailConfirmed: true })
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { error = ConfirmEmailFirst });
        }
        var household = _currentUser.OwnerId ?? string.Empty;
        if (!_resendCooldown.TryClaim(household, id))
        {
            return StatusCode(StatusCodes.Status429TooManyRequests, new { error = ResendTooSoon });
        }
        if (!_inviteAllowance.TryClaim(household))
        {
            _resendCooldown.Release(household, id);
            return StatusCode(StatusCodes.Status429TooManyRequests, new { error = InviteEmailAllowance.Refused });
        }

        var emailSent = false;
        try
        {
            var result = await _mediator.Send(new ResendInviteCommand(id), ct);
            if (result.InviteToken is { } token)
            {
                emailSent = await _accountEmails.TrySendInviteLinkAsync(result.Email, InviterName(me), token, ct);
                // The new link replaces the old one only once its email went out (review P3-2).
                if (emailSent)
                {
                    await _mediator.Send(new CommitResentInviteCommand(id, token), ct);
                }
            }
            else
            {
                var sent = await _accountEmails.TrySendPasswordLinkAsync(result.Email, ct);
                if (sent == PasswordLinkResult.TooSoon)
                {
                    return StatusCode(StatusCodes.Status429TooManyRequests, new { error = PasswordLinkTooSoon });
                }
                emailSent = sent == PasswordLinkResult.Sent;
            }
            return Ok(new ResendResponse(emailSent));
        }
        finally
        {
            // Nothing went out (refused, or the provider failed): the owner may try again at once.
            if (!emailSent)
            {
                _resendCooldown.Release(household, id);
                _inviteAllowance.Release(household);
            }
        }
    }

    public const string PasswordLinkTooSoon =
        "We've already sent this person a few password links. Give them time to arrive, or try again in 15 minutes.";

    public const string ResendTooSoon = "We sent that email less than a minute ago. Give it a moment to arrive.";

    public const string EmailNotSetUp =
        "Email isn't set up on this server yet, so invites can't be sent. Try again once it is.";

    public const string ConfirmEmailFirst =
        "Confirm your own email address first (use the link we sent you), then you can invite people.";

    private async Task<ApplicationUser?> CurrentLoginAsync()
    {
        var id = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return id is null ? null : await _userManager.FindByIdAsync(id);
    }

    /// <summary>
    /// How the invite email names the person who sent it. The display name is free text the inviter
    /// chose, so it is cut short and dropped when it looks like a link or an address: an invite
    /// can't carry "Visit evil.example to claim your refund" in AllotJar's name (audit A06-001).
    /// </summary>
    public static string InviterName(ApplicationUser me)
    {
        var name = me.DisplayName?.Trim();
        if (string.IsNullOrEmpty(name))
        {
            name = me.Email;
        }
        if (string.IsNullOrWhiteSpace(name))
        {
            return "Someone";
        }
        // The account's own (now confirmed) email is fine as-is; anything else is checked.
        if (string.Equals(name, me.Email, StringComparison.OrdinalIgnoreCase))
        {
            return name;
        }
        if (LooksLikeLink(name))
        {
            return "Someone";
        }
        return name.Length <= MaxInviterNameLength ? name : name[..MaxInviterNameLength].TrimEnd() + "\u2026";
    }

    public const int MaxInviterNameLength = 40;

    private static bool LooksLikeLink(string name) =>
        name.Contains("://", StringComparison.Ordinal)
        || name.Contains("www.", StringComparison.OrdinalIgnoreCase)
        || name.Contains('@')
        || name.Contains('/')
        || name.Contains('\\')
        || System.Text.RegularExpressions.Regex.IsMatch(name, @"[A-Za-z0-9-]\.[A-Za-z]{2,}");

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

    /// <summary>
    /// "This isn't me" (S-P3-8, D5): the caller releases its own earlier link to a budget person,
    /// so it no longer stops that person's own login making their accounts private. Only ever the
    /// caller's own link; nobody can release another login's.
    /// </summary>
    [HttpPost("people/{memberId:guid}/not-me")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> NotMe(Guid memberId, CancellationToken ct)
    {
        await _mediator.Send(new ReleasePersonLoginCommand(memberId), ct);
        return NoContent();
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

/// <summary>
/// An invite's outcome: the new membership, and whether its email went out. The link itself
/// travels only by email.
/// </summary>
public record InviteResponse(MembershipDto Membership, bool EmailSent);

/// <summary>Whether "Send again" got its email out.</summary>
public record ResendResponse(bool EmailSent);

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
