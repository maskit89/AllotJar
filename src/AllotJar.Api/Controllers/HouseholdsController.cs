using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using AllotJar.Api.Contracts.Auth;
using AllotJar.Application.Common.Interfaces;
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
            _db, user, DateTime.UtcNow, seedSampleBudget: false, ct);

        // Land them in their own household (null = own).
        if (user.ActiveOwnerId is not null)
        {
            user.ActiveOwnerId = null;
            await _userManager.UpdateAsync(user);
        }

        return NoContent();
    }

    /// <summary>
    /// Removes the caller's own access to a household they joined — a self-service "leave", so a
    /// member never has to ask the owner to remove them. You cannot leave your OWN household (you're
    /// the owner; there is nothing to leave). If it was the active household, falls back to your own.
    /// </summary>
    [HttpPost("leave")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
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
                _db, user, DateTime.UtcNow, seedSampleBudget: false, ct);

            // If they were viewing the household they just left, drop back to their own.
            if (user.ActiveOwnerId == request.OwnerId)
            {
                user.ActiveOwnerId = null;
                await _userManager.UpdateAsync(user);
            }
        }

        return NoContent();
    }
}
