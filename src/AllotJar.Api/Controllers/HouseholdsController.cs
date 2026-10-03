using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using AllotJar.Api.Contracts.Auth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Lets a login switch which household it is currently acting in. A login can belong to several
/// households; the active one is stored on the user (<c>ActiveOwnerId</c>) and resolved per request by
/// <see cref="Middleware.HouseholdResolutionMiddleware"/>. The full list is returned by <c>/auth/me</c>.
/// </summary>
[ApiController]
[Authorize]
[Route("api/households")]
public class HouseholdsController : ControllerBase
{
    private readonly ApplicationDbContext _db;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly ICurrentUser _currentUser;

    public HouseholdsController(
        ApplicationDbContext db, UserManager<ApplicationUser> userManager, ICurrentUser currentUser)
    {
        _db = db;
        _userManager = userManager;
        _currentUser = currentUser;
    }

    /// <summary>
    /// Switches the active household. The caller must have an active membership there (their own
    /// household always qualifies). The change takes effect on the next request; refetch <c>/auth/me</c>.
    /// </summary>
    [HttpPost("switch")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Switch(SwitchHouseholdRequest request, CancellationToken ct)
    {
        var userId = _currentUser.UserId;
        if (userId is null)
        {
            return Unauthorized();
        }

        var targetOwnerId = request.OwnerId;
        var isOwn = targetOwnerId == userId;
        var hasAccess = isOwn || await _db.HouseholdMemberships
            .AnyAsync(
                m => m.UserId == userId && m.OwnerId == targetOwnerId && m.Status == MembershipStatus.Active,
                ct);
        if (!hasAccess)
        {
            return NotFound(new { error = "You don't have access to that household." });
        }

        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        // Null means "my own household" — keeps the stored default tidy.
        user.ActiveOwnerId = isOwn ? null : targetOwnerId;
        await _userManager.UpdateAsync(user);

        return NoContent();
    }

    /// <summary>
    /// Creates the caller's OWN household — an Owner membership and the owner as member #1 — and
    /// switches them into it. This is the path for someone who only ever joined another household
    /// by invite and now wants a budget of their own; they land on the dashboard's create-month
    /// flow (blank or template) rather than pre-filled sample figures. Idempotent: if they already
    /// own a household this simply switches them back into it.
    /// </summary>
    [HttpPost("start-own")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> StartOwn(CancellationToken ct)
    {
        var userId = _currentUser.UserId;
        if (userId is null)
        {
            return Unauthorized();
        }

        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        // No sample figures: someone deliberately starting their own budget gets the dashboard's
        // create-month flow, not pre-filled data to clean up.
        await HouseholdBootstrap.EnsureOwnHouseholdAsync(
            _db, user, DateTime.UtcNow, ct);

        // Land them in their own household (null = own).
        if (user.ActiveOwnerId is not null)
        {
            user.ActiveOwnerId = null;
            await _userManager.UpdateAsync(user);
        }

        return NoContent();
    }

    /// <summary>
    /// How many accounts in a household the caller joined are private to the caller. Leaving makes
    /// them unreachable, and the owner may then erase them unseen (P59), so the leave asks first.
    /// </summary>
    [HttpGet("leave-preview")]
    [ProducesResponseType(typeof(LeavePreviewResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> LeavePreview([FromQuery] string ownerId, CancellationToken ct)
    {
        var userId = _currentUser.UserId;
        if (userId is null)
        {
            return Unauthorized();
        }

        var member = await _db.HouseholdMemberships.AnyAsync(
            m => m.UserId == userId && m.OwnerId == ownerId && m.Status == MembershipStatus.Active, ct);
        if (!member)
        {
            return NotFound(new { error = "You don't have access to that household." });
        }

        return Ok(new LeavePreviewResponse(await PrivateAccountCountAsync(userId, ownerId, ct)));
    }

    /// <summary>The caller's private accounts in <paramref name="ownerId"/>'s household.</summary>
    private Task<int> PrivateAccountCountAsync(string userId, string ownerId, CancellationToken ct) =>
        _db.AccountPrivacies.CountAsync(
            p => p.UserId == userId
                 && _db.Accounts.IgnoreQueryFilters().Any(a => a.Id == p.AccountId && a.OwnerId == ownerId),
            ct);

    /// <summary>
    /// Removes the caller's own access to a household they joined — a self-service "leave", so a
    /// member never has to ask the owner to remove them. You cannot leave your OWN household (you're
    /// the owner; there is nothing to leave). If it was the active household, falls back to your own.
    /// A leaver holding private accounts there must have been told how many (409 until then).
    /// </summary>
    [HttpPost("leave")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> Leave(LeaveHouseholdRequest request, CancellationToken ct)
    {
        var userId = _currentUser.UserId;
        if (userId is null)
        {
            return Unauthorized();
        }

        if (request.OwnerId == userId)
        {
            return BadRequest(new { error = "You can't leave your own household." });
        }

        var membership = await _db.HouseholdMemberships.FirstOrDefaultAsync(
            m => m.UserId == userId && m.OwnerId == request.OwnerId && m.Status == MembershipStatus.Active, ct);
        if (membership is null)
        {
            return NotFound(new { error = "You don't have access to that household." });
        }

        // Belt-and-braces: the owner's own membership can never match the userId != OwnerId guard
        // above, but never let a household lose its owner this way.
        if (membership.Role == HouseholdRole.Owner)
        {
            return BadRequest(new { error = "The owner can't leave their own household." });
        }

        // S-P3-7: once the login has gone, its private accounts there are hidden from everyone and
        // the owner may erase them (P59). Leave only once the leaver has seen how many there are.
        var privateAccounts = await PrivateAccountCountAsync(userId, request.OwnerId, ct);
        if (privateAccounts > request.PrivateAccounts)
        {
            return Conflict(new { error = LeavingPrivateAccounts(privateAccounts), privateAccounts });
        }

        // S-P3-8: the link stays on record, should this login be given access again; while it is
        // gone it doesn't count.
        await PersonLoginRecords.RecordUnlinkAsync(_db, membership.MemberId, userId, ct);
        _db.HouseholdMemberships.Remove(membership);
        await _db.SaveChangesAsync(ct);

        var user = await _userManager.FindByIdAsync(userId);
        if (user is not null)
        {
            // A member who only ever joined others has no own household; after leaving, the
            // resolver would drop them into one that doesn't exist. Materialize it (membership +
            // owner member) so they land somewhere real — the dashboard's create-month flow takes
            // it from there; sample figures are never injected by a background path. Idempotent —
            // a no-op for a user who already owns a household.
            await HouseholdBootstrap.EnsureOwnHouseholdAsync(
                _db, user, DateTime.UtcNow, ct);

            // If they were viewing the household they just left, drop back to their own.
            if (user.ActiveOwnerId == request.OwnerId)
            {
                user.ActiveOwnerId = null;
                await _userManager.UpdateAsync(user);
            }
        }

        return NoContent();
    }

    public static string LeavingPrivateAccounts(int count)
    {
        var them = count == 1 ? "it" : "them";
        return $"You keep {count} private {(count == 1 ? "account" : "accounts")} in this household. Once you leave, " +
               $"nobody can see {them} and the owner can erase {them} for good. Share {them} first, or confirm to leave anyway.";
    }
}
