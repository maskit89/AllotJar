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
}
