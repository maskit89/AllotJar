using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Export;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Controllers;

/// <summary>
/// "Download my data" on Account settings (compliance fix 4): a zip of everything the signed-in
/// login can see in the household it is viewing, as JSON and one CSV per table. Every access level
/// may download; nothing is changed.
/// </summary>
[ApiController]
[Authorize]
[Route("api/[controller]")]
public class ExportController : ControllerBase
{
    private readonly ISender _mediator;
    private readonly UserManager<ApplicationUser> _userManager;
    private readonly ApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IRefreshTokenService _refreshTokens;

    public ExportController(
        ISender mediator, UserManager<ApplicationUser> userManager, ApplicationDbContext db, ICurrentUser currentUser,
        IRefreshTokenService refreshTokens)
    {
        _refreshTokens = refreshTokens;
        _mediator = mediator;
        _userManager = userManager;
        _db = db;
        _currentUser = currentUser;
    }

    /// <summary>The zip, named allotjar-data-YYYY-MM-DD.zip.</summary>
    [HttpGet]
    [EnableRateLimiting("export")]
    [Produces("application/zip")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status429TooManyRequests)]
    public async Task<IActionResult> Download(CancellationToken ct)
    {
        var userId = _currentUser.UserId;
        var user = userId is null ? null : await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        var ownerId = _currentUser.OwnerId ?? user.Id;
        // A household is named as the switcher names it: never by the owner's email (S-P3-9).
        var household = ownerId == user.Id
            ? "Your household"
            : await _db.Users.AsNoTracking().Where(u => u.Id == ownerId).Select(u => u.DisplayName).FirstOrDefaultAsync(ct)
                is { } name && !string.IsNullOrWhiteSpace(name) ? name : "Household";

        var profile = new ExportProfile(
            user.Email!,
            user.FirstName,
            user.LastName,
            user.DisplayName,
            user.EmailConfirmed,
            user.ConsentedUtc,
            await _userManager.HasPasswordAsync(user),
            (await _userManager.GetLoginsAsync(user)).Any(l => l.LoginProvider == "Google"),
            UserPreferences.NormalizeCurrency(user.PreferredCurrency) ?? UserPreferences.DefaultCurrency,
            UserPreferences.NormalizeNumberFormat(user.NumberFormat) ?? UserPreferences.DefaultNumberFormat,
            household,
            (_currentUser.Role ?? HouseholdRole.Owner).ToString());

        // The devices it is signed in on, as the Devices card lists them.
        var signIns = (await _refreshTokens.ListActiveAsync(user.Id, null, ct))
            .Select(s => new ExportedSignIn(s.Device, s.StartedUtc, s.LastActiveUtc))
            .ToList();

        // Its passkeys: where and when each was added (the keys themselves are not personal data to hand over).
        var passkeys = (await _userManager.GetPasskeysAsync(user))
            .OrderBy(p => p.CreatedAt)
            .Select(p => new ExportedPasskey(p.Name, p.CreatedAt.UtcDateTime))
            .ToList();

        var export = await _mediator.Send(new ExportMyDataQuery(profile, SignIns: signIns, Passkeys: passkeys), ct);
        // Never cached: it is personal data, and a second download should be today's.
        Response.Headers.CacheControl = "no-store";
        return File(DataExportArchive.Build(export), "application/zip", DataExportArchive.FileName(export.ExportedUtc));
    }
}
