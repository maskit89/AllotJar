using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using AllotJar.Api.Contracts.Auth;
using AllotJar.Application.Auth.Commands.Login;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public class AuthController : ControllerBase
{
    /// <summary>HttpOnly cookie that carries the refresh token; scoped to the auth endpoints only.</summary>
    private const string RefreshCookieName = "zbb_rt";

    private readonly UserManager<ApplicationUser> _userManager;
    private readonly IJwtTokenGenerator _tokenGenerator;
    private readonly IRefreshTokenService _refreshTokens;
    private readonly ApplicationDbContext _db;
    private readonly ISender _mediator;
    private readonly ICurrentUser _currentUser;
    private readonly IWebHostEnvironment _env;

    public AuthController(
        UserManager<ApplicationUser> userManager,
        IJwtTokenGenerator tokenGenerator,
        IRefreshTokenService refreshTokens,
        ApplicationDbContext db,
        ISender mediator,
        ICurrentUser currentUser,
        IWebHostEnvironment env)
    {
        _userManager = userManager;
        _tokenGenerator = tokenGenerator;
        _refreshTokens = refreshTokens;
        _db = db;
        _mediator = mediator;
        _currentUser = currentUser;
        _env = env;
    }

    /// <summary>Creates an account, seeds a starter budget + owner membership + owner member, returns a JWT.</summary>
    [HttpPost("register")]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> Register(RegisterRequest request, CancellationToken ct)
    {
        if (!request.AcceptedTerms)
        {
            return BadRequest(new { error = "Please accept the terms and privacy policy to create an account." });
        }

        var currency = UserPreferences.NormalizeCurrency(request.PreferredCurrency);
        if (currency is null)
        {
            return BadRequest(new { error = "That isn't a valid ISO 4217 currency code." });
        }

        var numberFormat = UserPreferences.NormalizeNumberFormat(request.NumberFormat);
        if (numberFormat is null)
        {
            return BadRequest(new { error = "That number format isn't supported." });
        }

        var existing = await _userManager.FindByEmailAsync(request.Email);
        if (existing is not null)
        {
            return BadRequest(new { error = "An account with that email already exists." });
        }

        var firstName = NullIfBlank(request.FirstName);
        var lastName = NullIfBlank(request.LastName);

        var user = new ApplicationUser
        {
            UserName = request.Email,
            Email = request.Email,
            DisplayName = ComposeDisplayName(firstName, lastName),
            FirstName = firstName,
            LastName = lastName,
            PreferredCurrency = currency,
            NumberFormat = numberFormat,
            ConsentedUtc = DateTime.UtcNow,
        };

        var result = await _userManager.CreateAsync(user, request.Password);
        if (!result.Succeeded)
        {
            return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
        }

        // The new user owns their own household, and gets a starter budget to look at.
        var now = DateTime.UtcNow;
        _db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = user.Id,
            UserId = user.Id,
            Role = HouseholdRole.Owner,
            Status = MembershipStatus.Active,
            InvitedEmail = user.Email!,
            DisplayName = user.DisplayName,
            CreatedUtc = now,
        });
        await _db.SaveChangesAsync(ct);
        await BudgetSeeder.SeedDefaultMonthAsync(_db, user.Id, now.Year, now.Month, ct);

        // The owner is themselves member #1, so a household is never "0 members": solo is a
        // household of one, shared is two or more.
        await OwnerMemberSeeder.EnsureOwnerMemberAsync(
            _db, user.Id, OwnerMemberSeeder.ResolveOwnerName(firstName, user.DisplayName, user.Email), ct);

        await IssueRefreshCookieAsync(user.Id, ct);
        return Ok(await BuildResponseAsync(user, ct));
    }

    /// <summary>Validates credentials and returns a JWT.</summary>
    [HttpPost("login")]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Login(LoginRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(new LoginCommand(request.Email, request.Password), ct);

        if (result.Outcome == LoginOutcome.Success)
        {
            await IssueRefreshCookieAsync(result.UserId!, ct);
            return Ok(new AuthResponse(
                result.Token!, result.ExpiresAtUtc, result.UserId!, result.Email!, result.Role, result.DisplayName));
        }

        if (result.Outcome == LoginOutcome.LockedOut)
        {
            return Unauthorized(new
            {
                error = "Your account is temporarily locked after too many failed sign-in attempts. " +
                        "Please try again in a few minutes."
            });
        }

        // Same response for unknown user and bad password — no account enumeration.
        return Unauthorized(new { error = "Invalid email or password." });
    }

    /// <summary>Redeems a one-time invite link, creates the login and returns a JWT.</summary>
    [HttpPost("accept-invite")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> AcceptInvite(AcceptInviteRequest request, CancellationToken ct)
    {
        var result = await _mediator.Send(
            new AcceptInviteCommand(request.Token, request.Password, request.DisplayName), ct);

        var user = await _userManager.FindByIdAsync(result.UserId);
        var stamp = user is null ? null : await _userManager.GetSecurityStampAsync(user);
        var (token, expiresAt) = _tokenGenerator.Generate(result.UserId, result.Email, stamp);
        await IssueRefreshCookieAsync(result.UserId, ct);
        return Ok(new AuthResponse(token, expiresAt, result.UserId, result.Email, result.Role, request.DisplayName));
    }

    /// <summary>Exchanges the refresh cookie for a fresh access token, rotating the cookie.</summary>
    [HttpPost("refresh")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Refresh(CancellationToken ct)
    {
        var raw = Request.Cookies[RefreshCookieName];
        if (string.IsNullOrEmpty(raw))
        {
            return Unauthorized();
        }

        var rotation = await _refreshTokens.RotateAsync(raw, ct);
        if (!rotation.Succeeded)
        {
            ClearRefreshCookie();
            return Unauthorized();
        }

        var user = await _userManager.FindByIdAsync(rotation.UserId!);
        if (user is null)
        {
            ClearRefreshCookie();
            return Unauthorized();
        }

        SetRefreshCookie(rotation.NewRawToken!);
        return Ok(await BuildResponseAsync(user, ct));
    }

    /// <summary>Signs the caller out by revoking + clearing the refresh cookie.</summary>
    [HttpPost("logout")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> Logout(CancellationToken ct)
    {
        var raw = Request.Cookies[RefreshCookieName];
        if (!string.IsNullOrEmpty(raw))
        {
            await _refreshTokens.RevokeAsync(raw, ct);
        }

        ClearRefreshCookie();
        return NoContent();
    }

    /// <summary>Changes the authenticated login's own password.</summary>
    [HttpPost("change-password")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is null)
        {
            return Unauthorized();
        }

        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        var result = await _userManager.ChangePasswordAsync(user, request.CurrentPassword, request.NewPassword);
        if (!result.Succeeded)
        {
            return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
        }

        return NoContent();
    }

    /// <summary>The authenticated login's identity, household and access level.</summary>
    [HttpGet("me")]
    [Authorize]
    [ProducesResponseType(typeof(MeResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Me()
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

        var activeOwnerId = _currentUser.OwnerId ?? userId;
        var households = await BuildHouseholdsAsync(userId, activeOwnerId, HttpContext.RequestAborted);

        return Ok(new MeResponse(
            userId,
            user.Email!,
            user.DisplayName,
            _currentUser.Role ?? HouseholdRole.Owner,
            activeOwnerId,
            _currentUser.MemberId,
            user.FirstName,
            user.LastName,
            ResolveCurrency(user.PreferredCurrency),
            ResolveNumberFormat(user.NumberFormat),
            households));
    }

    /// <summary>The households this login can act in (for the switcher), with the active one flagged.</summary>
    private async Task<IReadOnlyList<HouseholdSummary>> BuildHouseholdsAsync(
        string userId, string activeOwnerId, CancellationToken ct)
    {
        var memberships = await _db.HouseholdMemberships
            .AsNoTracking()
            .Where(m => m.UserId == userId && m.Status == MembershipStatus.Active)
            .Select(m => new { m.OwnerId, m.Role })
            .ToListAsync(ct);

        var ownerIds = memberships.Select(m => m.OwnerId).Distinct().ToList();
        var owners = await _db.Users
            .AsNoTracking()
            .Where(u => ownerIds.Contains(u.Id))
            .Select(u => new { u.Id, u.DisplayName, u.Email })
            .ToDictionaryAsync(u => u.Id, ct);

        var households = memberships
            .Select(m =>
            {
                var isOwn = m.OwnerId == userId;
                owners.TryGetValue(m.OwnerId, out var owner);
                var label = isOwn ? "Your household" : owner?.DisplayName ?? owner?.Email ?? "Household";
                return new HouseholdSummary(m.OwnerId, label, m.Role, m.OwnerId == activeOwnerId, isOwn);
            })
            .OrderByDescending(h => h.IsOwn)
            .ThenBy(h => h.Label)
            .ToList();

        // A login with no membership row yet still owns its own household.
        if (households.Count == 0)
        {
            households.Add(new HouseholdSummary(userId, "Your household", HouseholdRole.Owner, true, true));
        }

        return households;
    }

    /// <summary>Updates the authenticated login's name and money-display preferences.</summary>
    [HttpPut("preferences")]
    [Authorize]
    [ProducesResponseType(typeof(PreferencesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> UpdatePreferences(UpdatePreferencesRequest request)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is null)
        {
            return Unauthorized();
        }

        var user = await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        // A blank currency/format means "leave as is", so a name-only save can't reset them.
        var currency = UserPreferences.NormalizeCurrency(
            string.IsNullOrWhiteSpace(request.PreferredCurrency) ? user.PreferredCurrency : request.PreferredCurrency);
        if (currency is null)
        {
            return BadRequest(new { error = "That isn't a valid ISO 4217 currency code." });
        }

        var numberFormat = UserPreferences.NormalizeNumberFormat(
            string.IsNullOrWhiteSpace(request.NumberFormat) ? user.NumberFormat : request.NumberFormat);
        if (numberFormat is null)
        {
            return BadRequest(new { error = "That number format isn't supported." });
        }

        user.FirstName = NullIfBlank(request.FirstName);
        user.LastName = NullIfBlank(request.LastName);
        user.DisplayName = ComposeDisplayName(user.FirstName, user.LastName);
        user.PreferredCurrency = currency;
        user.NumberFormat = numberFormat;

        var result = await _userManager.UpdateAsync(user);
        if (!result.Succeeded)
        {
            return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
        }

        return Ok(new PreferencesResponse(
            user.FirstName, user.LastName, user.DisplayName, user.PreferredCurrency, user.NumberFormat));
    }

    private static string? NullIfBlank(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }

    private static string? ComposeDisplayName(string? firstName, string? lastName)
    {
        var composed = $"{firstName} {lastName}".Trim();
        return composed.Length == 0 ? null : composed;
    }

    private static string ResolveCurrency(string? value) =>
        UserPreferences.NormalizeCurrency(value) ?? UserPreferences.DefaultCurrency;

    private static string ResolveNumberFormat(string? value) =>
        UserPreferences.NormalizeNumberFormat(value) ?? UserPreferences.DefaultNumberFormat;

    /// <summary>Issues a fresh refresh token and writes it to the HttpOnly cookie.</summary>
    private async Task IssueRefreshCookieAsync(string userId, CancellationToken ct)
    {
        var raw = await _refreshTokens.IssueAsync(userId, ct);
        SetRefreshCookie(raw);
    }

    private void SetRefreshCookie(string rawToken) =>
        Response.Cookies.Append(RefreshCookieName, rawToken, new CookieOptions
        {
            HttpOnly = true,
            // Secure requires HTTPS, which we always have in prod (Cloudflare); local dev is plain http.
            Secure = !_env.IsDevelopment(),
            SameSite = SameSiteMode.Strict,
            Path = "/api/auth",
            Expires = DateTimeOffset.UtcNow.AddDays(RefreshTokenService.LifetimeDays),
            IsEssential = true,
        });

    private void ClearRefreshCookie() =>
        Response.Cookies.Delete(RefreshCookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = !_env.IsDevelopment(),
            SameSite = SameSiteMode.Strict,
            Path = "/api/auth",
        });

    private async Task<AuthResponse> BuildResponseAsync(ApplicationUser user, CancellationToken ct)
    {
        var role = await _db.HouseholdMemberships
            .Where(m => m.UserId == user.Id && m.Status == MembershipStatus.Active)
            .Select(m => (HouseholdRole?)m.Role)
            .FirstOrDefaultAsync(ct) ?? HouseholdRole.Owner;

        var stamp = await _userManager.GetSecurityStampAsync(user);
        var (token, expiresAt) = _tokenGenerator.Generate(user.Id, user.Email!, stamp);
        return new AuthResponse(token, expiresAt, user.Id, user.Email!, role, user.DisplayName);
    }
}
