using System.Security.Claims;
using MediatR;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using AllotJar.Api.Contracts.Auth;
using AllotJar.Api.Middleware;
using AllotJar.Api.Services;
using AllotJar.Application.Accounts;
using AllotJar.Application.Auth.Commands.Login;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Households;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Controllers;

[ApiController]
[Route("api/[controller]")]
public partial class AuthController : ControllerBase
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
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly EmailSettings _emailSettings;
    private readonly ILogger<AuthController> _logger;
    private readonly IIdentityService _identity;
    private readonly AccountEmails _accountEmails;

    public AuthController(
        UserManager<ApplicationUser> userManager,
        IJwtTokenGenerator tokenGenerator,
        IRefreshTokenService refreshTokens,
        ApplicationDbContext db,
        ISender mediator,
        ICurrentUser currentUser,
        IWebHostEnvironment env,
        IServiceScopeFactory scopeFactory,
        IOptions<EmailSettings> emailSettings,
        ILogger<AuthController> logger,
        IIdentityService identity,
        AccountEmails accountEmails)
    {
        _accountEmails = accountEmails;
        _userManager = userManager;
        _tokenGenerator = tokenGenerator;
        _refreshTokens = refreshTokens;
        _db = db;
        _mediator = mediator;
        _currentUser = currentUser;
        _env = env;
        _scopeFactory = scopeFactory;
        _emailSettings = emailSettings.Value;
        _logger = logger;
        _identity = identity;
    }

    /// <summary>Creates an account (owner membership + owner member, plus a sample budget only when
    /// returns a JWT.</summary>
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
            // A VERIFIED account genuinely belongs to someone — say so (registration already reveals
            // existence; accepted trade-off). An UNVERIFIED account, though, may be a pre-hijack
            // squat (we never verified the email at its registration): rather than let the new
            // registrant in OR leave them stuck, email a claim link to the address so its TRUE
            // owner can take it over. Same neutral response either way — no session is issued.
            if (await _userManager.IsEmailConfirmedAsync(existing))
            {
                return BadRequest(new { error = "An account with that email already exists." });
            }

            DispatchReclaimEmail(request.Email);
            return Ok(new RegistrationPendingResponse(VerificationPending: true, request.Email));
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

        // The new user owns their own household (Owner membership + owner member; nothing is
        // seeded, rule 81). The owner is themselves member #1, so a household is never
        // "0 members": solo is a household of one, shared is two or more.
        await HouseholdBootstrap.EnsureOwnHouseholdAsync(
            _db, user, DateTime.UtcNow, ct);

        // Send the "confirm your email" link. The user is signed in immediately (below) and can use
        // the app right away — a persistent banner nudges them to confirm; sending is off-request.
        DispatchVerificationEmail(user.Id);

        await IssueRefreshCookieAsync(user.Id, ct);
        return Ok(await BuildResponseAsync(user, ct));
    }

    /// <summary>
    /// Confirms an emailed address-verification token (the normal path: a registrant clicks the
    /// link). Failures share one generic message so a dead/foreign token gives no token-validity
    /// signal. Note the idempotent 204-on-already-confirmed short-circuit (below) does distinguish a
    /// confirmed account from an unverified/unknown one for a known email — an existence/verified
    /// oracle strictly weaker than what registration already exposes, rate-limited, and accepted
    /// under the same registration-enumeration trade-off (docs/testing/maps/auth.md §8/§17).
    /// </summary>
    [HttpPost("confirm-email")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> ConfirmEmail(ConfirmEmailRequest request)
    {
        const string invalid = "That confirmation link is invalid or has expired. Please request a new one.";

        var user = await _userManager.FindByEmailAsync(request.Email);
        if (user is null)
        {
            return BadRequest(new { error = invalid });
        }

        if (await _userManager.IsEmailConfirmedAsync(user))
        {
            return NoContent(); // idempotent — clicking a still-valid link twice is fine
        }

        var result = await _userManager.ConfirmEmailAsync(user, request.Token);
        return result.Succeeded ? NoContent() : BadRequest(new { error = invalid });
    }

    /// <summary>Resends the address-verification email for the authenticated login (no-op + 204 if
    /// already confirmed, so it never leaks confirmation state to a different response).</summary>
    [HttpPost("resend-verification")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> ResendVerification()
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

        if (!await _userManager.IsEmailConfirmedAsync(user))
        {
            DispatchVerificationEmail(user.Id);
        }

        return NoContent();
    }

    /// <summary>
    /// Sends the address-verification email off the request path (like the reset dispatch): a fresh
    /// DI scope because the request scope's UserManager is disposed when we return. The link's token
    /// is Identity's email-confirmation token (2h lifespan, shared DataProtection lifetime).
    /// </summary>
    private void DispatchVerificationEmail(string userId)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = _scopeFactory.CreateScope();
                var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
                var user = await users.FindByIdAsync(userId);
                if (user is null || string.IsNullOrEmpty(user.Email))
                {
                    return;
                }

                var token = await users.GenerateEmailConfirmationTokenAsync(user);
                var link = $"{_emailSettings.AppBaseUrl.TrimEnd('/')}/confirm-email" +
                           $"?email={Uri.EscapeDataString(user.Email)}&token={Uri.EscapeDataString(token)}";
                var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
                await sender.SendAsync(EmailVerificationEmail.Build(user.Email, link));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send an email-verification message.");
            }
        });
    }

    /// <summary>
    /// The safe-reclaim dispatch: register hit an existing UNVERIFIED email, so email a
    /// PASSWORD-RESET link to that address. Whoever controls the inbox (the true owner) redeems it,
    /// and the reset flow takes the account over — sets a new password, marks the email confirmed,
    /// and revokes any sessions a squatter held. Reuses the reset machinery wholesale.
    /// </summary>
    private void DispatchReclaimEmail(string email) => DispatchResetEmail(email);

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
            // A login with a passkey answers it too before this device signs in (fix 14).
            var user = await _userManager.FindByIdAsync(result.UserId!);
            if (user is not null && (await _userManager.GetPasskeysAsync(user)).Count > 0)
            {
                return await SignInOrAskForPasskeyAsync(user, ct);
            }

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

    /// <summary>
    /// Exchanges a verified Google ID token for an AllotJar session (or, for a login with a passkey,
    /// the second step to answer first). Resolution order:
    /// the Google identity link (permanent `sub`) wins; else a VERIFIED-email match auto-links to
    /// the existing account (Google attests the email, so its holder already commands the same
    /// inbox a password reset would trust); else a new passwordless account is created — same
    /// bootstrap as registration, no sample budget, and terms consent collected on first load via
    /// the existing NeedsConsent/ConsentModal path (the invite-created-login pattern).
    /// Google sign-in deliberately ignores password lockout: lockout throttles password GUESSING,
    /// while a valid Google token is cryptographic proof of account control — honouring lockout
    /// here would lock the victim of a guessing attack out of their own recovery path.
    /// </summary>
    [HttpPost("google")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> GoogleLogin(
        GoogleLoginRequest request,
        [FromServices] IGoogleIdTokenValidator googleValidator,
        CancellationToken ct)
    {
        const string providerName = "Google";

        var identity = await googleValidator.ValidateAsync(request.Credential, ct);
        if (identity is null)
        {
            // Invalid/expired/foreign-audience token — or Google sign-in simply isn't configured.
            return Unauthorized(new { error = "Google sign-in could not be verified. Please try again." });
        }

        // The permanent Google account id is the ONLY safe link key (emails change and recycle).
        var user = await _userManager.FindByLoginAsync(providerName, identity.Subject);
        var isNewAccount = false;

        if (user is null)
        {
            // Auto-link requires Google's OWN attestation of the address. Without it, anyone able
            // to register an unverified Google identity claiming a victim's email could walk into
            // the victim's AllotJar account.
            if (!identity.EmailVerified)
            {
                return Unauthorized(new
                {
                    error = "Your Google account's email address is not verified, so it can't be " +
                            "used to sign in here. Verify it with Google, or use a password instead."
                });
            }

            var existing = await _userManager.FindByEmailAsync(identity.Email);
            if (existing is not null)
            {
                var link = await _userManager.AddLoginAsync(
                    existing, new UserLoginInfo(providerName, identity.Subject, providerName));
                if (!link.Succeeded)
                {
                    // e.g. the account is already linked to a DIFFERENT Google identity.
                    _logger.LogWarning(
                        "Google link to an existing account failed: {Codes}",
                        string.Join("; ", link.Errors.Select(e => e.Code)));
                    return Unauthorized(new { error = "Google sign-in could not be verified. Please try again." });
                }

                await NeutralizePreExistingCredentialAsync(existing, ct);
                user = existing;
            }
            else
            {
                (user, var created) = await CreateGoogleUserAsync(identity, request, providerName, ct);
                if (user is null)
                {
                    return Unauthorized(new { error = "Google sign-in could not be verified. Please try again." });
                }
                isNewAccount = created;
            }
        }

        return await SignInOrAskForPasskeyAsync(user, ct, response => response with { IsNewAccount = isNewAccount });
    }

    /// <summary>
    /// Creates the passwordless account for a first-time Google user: profile from Google's
    /// attested claims, currency/format from the client's locale detection (register-form
    /// parity; invalid values fall back to the defaults rather than failing sign-in),
    /// ConsentedUtc deliberately NULL so the ConsentModal collects terms on first load, and the
    /// same household bootstrap as registration — without the sample budget (that is opt-in on
    /// the register form, and this user never saw the form). Races with a concurrent first
    /// sign-in for the same email are resolved by re-reading instead of failing.
    /// </summary>
    private async Task<(ApplicationUser? User, bool Created)> CreateGoogleUserAsync(
        GoogleIdentity identity, GoogleLoginRequest request, string providerName, CancellationToken ct)
    {
        var user = new ApplicationUser
        {
            UserName = identity.Email,
            Email = identity.Email,
            EmailConfirmed = true, // Google attested it — that is stronger than our own confirm flow
            FirstName = identity.GivenName,
            LastName = identity.FamilyName,
            DisplayName = ComposeDisplayName(identity.GivenName, identity.FamilyName)
                ?? NullIfBlank(identity.DisplayName),
            PreferredCurrency = UserPreferences.NormalizeCurrency(request.PreferredCurrency)
                ?? UserPreferences.DefaultCurrency,
            NumberFormat = UserPreferences.NormalizeNumberFormat(request.NumberFormat)
                ?? UserPreferences.DefaultNumberFormat,
            ConsentedUtc = null,
        };

        var createResult = await _userManager.CreateAsync(user); // passwordless — no PasswordHash
        if (!createResult.Succeeded)
        {
            // Most plausible cause: a concurrent request created the same email in between our
            // FindByEmail and here. Re-read; a still-missing user is a genuine failure.
            var raced = await _userManager.FindByEmailAsync(identity.Email);
            if (raced is null)
            {
                // Log error CODES, not descriptions — Identity descriptions embed the offending
                // value (e.g. the email address), which must not reach the logs as PII.
                _logger.LogError(
                    "Creating a Google-sign-in account failed: {Codes}",
                    string.Join("; ", createResult.Errors.Select(e => e.Code)));
                return (null, false);
            }

            await _userManager.AddLoginAsync(raced, new UserLoginInfo(providerName, identity.Subject, providerName));
            return (raced, false);
        }

        var linkResult = await _userManager.AddLoginAsync(
            user, new UserLoginInfo(providerName, identity.Subject, providerName));
        if (!linkResult.Succeeded)
        {
            _logger.LogError(
                "Linking the Google identity to a freshly created account failed: {Codes}",
                string.Join("; ", linkResult.Errors.Select(e => e.Code)));
        }

        // Owner membership + owner member #1 — a household is never "0 members". No sample budget.
        await HouseholdBootstrap.EnsureOwnHouseholdAsync(
            _db, user, DateTime.UtcNow, ct);

        return (user, true);
    }

    /// <summary>
    /// Closes the account **pre-hijacking** hole when Google links into a PRE-EXISTING account.
    ///
    /// AllotJar never verifies email ownership at registration (no confirmation email), so a
    /// password account's <c>EmailConfirmed</c> is false and ANYONE could have registered a
    /// victim's address with a password they know, waiting for the victim to arrive via Google.
    /// The moment Google attests that address belongs to the person signing in NOW, any
    /// pre-existing password on an UNVERIFIED-email account can no longer be trusted — so revoke
    /// every existing session (refresh tokens + a security-stamp rotation kills issued access
    /// tokens) and REMOVE the password. The legitimate owner keeps Google sign-in and can re-add a
    /// password via forgot-password (which re-proves email control). An already-verified account
    /// (only ever true for a prior Google link) keeps its password — nothing to distrust.
    /// </summary>
    private async Task NeutralizePreExistingCredentialAsync(ApplicationUser existing, CancellationToken ct)
    {
        // Google just proved the email; record that so a later link on the same account is trusted.
        var alreadyVerified = existing.EmailConfirmed;
        if (!alreadyVerified)
        {
            existing.EmailConfirmed = true;
        }

        if (!alreadyVerified && await _userManager.HasPasswordAsync(existing))
        {
            // The attacker's known password (if this was a pre-hijack) must stop working. With no
            // password left, an owner-set temporary one is no longer pending either.
            existing.MustChangePassword = false;
            await _userManager.RemovePasswordAsync(existing);
            _logger.LogInformation(
                "Removed the pre-existing password on {UserId} while linking Google to a " +
                "previously-unverified-email account (pre-hijacking defence).", existing.Id);
        }

        // Kill any session an attacker may already hold: refresh tokens + the stamp rotation that
        // fails every issued access token. RemovePasswordAsync/UpdateSecurityStampAsync both rotate
        // the stamp, but call it explicitly so the revoke holds even when no password was present.
        await _refreshTokens.RevokeAllForUserAsync(existing.Id, ct);
        await _userManager.UpdateSecurityStampAsync(existing);
    }

    /// <summary>
    /// Disconnects the Google identity from the authenticated login. Refused when Google is the
    /// login's ONLY way in (no password) — unlinking then would lock the user out of their own
    /// account; the account page tells them to set a password first (via forgot-password).
    ///
    /// Removing the login rotates the security stamp (Identity does this), which would otherwise
    /// invalidate THIS request's own access token and sign the user out mid-action — so, like
    /// change-password, we re-issue a fresh token + cookie and return the new session. Already-
    /// unlinked ⇒ 200 with the caller's current session unchanged (idempotent).
    /// </summary>
    [HttpPost("google/unlink")]
    [Authorize]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> UnlinkGoogle(CancellationToken ct)
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

        var googleLogins = (await _userManager.GetLoginsAsync(user))
            .Where(l => l.LoginProvider == "Google")
            .ToList();
        if (googleLogins.Count == 0)
        {
            return Ok(await BuildResponseAsync(user, ct)); // idempotent — nothing linked
        }

        if (!await _userManager.HasPasswordAsync(user))
        {
            return BadRequest(new
            {
                error = "Google is the only way you sign in, so it can't be disconnected. " +
                        "Set a password first (via Forgot password), then disconnect Google."
            });
        }

        foreach (var login in googleLogins)
        {
            await _userManager.RemoveLoginAsync(user, login.LoginProvider, login.ProviderKey);
        }

        // RemoveLoginAsync rotated the stamp, killing this device's access token — re-issue so the
        // user stays signed in (a fresh JWT carries the new stamp; the cookie is rotated too). The
        // sign-in carries on rather than starting again: disconnecting proves nothing, so it must not
        // count as a recent sign-in that lets passkeys change without proof.
        await ContinueRefreshCookieAsync(user.Id, ct);
        return Ok(await BuildResponseAsync(user, ct));
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
            new AcceptInviteCommand(request.Token, request.Password, request.DisplayName, request.AcceptedTerms), ct);

        // An anonymous accept CREATED an (unverified) login — send the initial verification email
        // exactly like registration does, off the request path. Without this the verify banner
        // told invite-created users to "check your inbox" while nothing had ever been sent
        // (only the Resend button would generate the first email).
        if (result.CreatedNewLogin)
        {
            DispatchVerificationEmail(result.UserId);
        }

        var user = await _userManager.FindByIdAsync(result.UserId);
        var stamp = user is null ? null : await _userManager.GetSecurityStampAsync(user);
        var (token, expiresAt) = _tokenGenerator.Generate(result.UserId, result.Email, stamp);
        // A new login has just set its password: a sign-in. A signed-in login accepting carries on
        // with the sign-in it has, which proved nothing new (see ContinueRefreshCookieAsync).
        if (result.CreatedNewLogin)
        {
            await IssueRefreshCookieAsync(result.UserId, ct);
        }
        else
        {
            await ContinueRefreshCookieAsync(result.UserId, ct);
        }
        return Ok(new AuthResponse(token, expiresAt, result.UserId, result.Email, result.Role, result.DisplayName));
    }

    /// <summary>
    /// Exchanges the refresh cookie for a fresh access token, rotating the cookie. Limited in its
    /// own bucket, so a flood of sign-in attempts can't end the sessions already open (S-P2-4).
    /// </summary>
    [HttpPost("refresh")]
    [AllowAnonymous]
    [EnableRateLimiting("auth-refresh")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Refresh(CancellationToken ct)
    {
        var raw = Request.Cookies[RefreshCookieName];
        if (string.IsNullOrEmpty(raw))
        {
            return Unauthorized();
        }

        // The rotation and the answer stand or fall together (#302 review P2-1): a failure after the
        // rotation was saved (loading the login, building the answer) would leave the browser holding
        // a cookie the server had already replaced, and its next refresh, replaying it outside the
        // grace window, would meet the theft response and sign out every device.
        await using var answer = _db.Database.IsRelational() ? await _db.Database.BeginTransactionAsync(ct) : null;
        var rotation = await _refreshTokens.RotateAsync(raw, CurrentDevice(), ct);
        if (!rotation.Succeeded)
        {
            if (answer is not null)
            {
                // A refusal may still have written (the theft response revokes every token).
                await answer.CommitAsync(ct);
            }
            // Superseded = a sibling tab just rotated this cookie, so the shared jar already
            // holds THAT tab's fresh token. Clearing here would delete it and sign the winning
            // tab out too, 15 minutes later, when its access token expires.
            if (!rotation.Superseded)
            {
                ClearRefreshCookie();
            }
            return Unauthorized();
        }

        var user = await _userManager.FindByIdAsync(rotation.UserId!);
        if (user is null)
        {
            ClearRefreshCookie();
            return Unauthorized();
        }

        var response = await BuildResponseAsync(user, ct);
        if (answer is not null)
        {
            await answer.CommitAsync(ct);
        }
        SetRefreshCookie(rotation.NewRawToken!, rotation.ExpiresUtc);
        return Ok(response);
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
            var userId = await _refreshTokens.RevokeAsync(raw, ct);
            if (userId is not null)
            {
                // Rotating the security stamp fails the sstamp check on every already-issued
                // access token, so sign-out takes effect now — not after the JWT's remaining
                // lifetime. Other devices recover silently: their next 401 refreshes via their
                // own still-valid cookie into a token carrying the new stamp.
                var user = await _userManager.FindByIdAsync(userId);
                if (user is not null)
                {
                    await _userManager.UpdateSecurityStampAsync(user);
                }
            }
        }

        ClearRefreshCookie();
        return NoContent();
    }

    /// <summary>The login's sign-ins still in force, one per device, this device's first.</summary>
    [HttpGet("sessions")]
    [Authorize]
    [ProducesResponseType(typeof(IReadOnlyList<SessionResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Sessions(CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is null)
        {
            return Unauthorized();
        }

        var sessions = await _refreshTokens.ListActiveAsync(userId, Request.Cookies[RefreshCookieName], ct);
        // Read back from the database as Unspecified: marked UTC so they reach the client with their Z.
        return Ok(sessions.Select(s => new SessionResponse(
            s.Id, s.Device, DateTime.SpecifyKind(s.StartedUtc, DateTimeKind.Utc), DateTime.SpecifyKind(s.LastActiveUtc, DateTimeKind.Utc), s.Current)));
    }

    /// <summary>
    /// Signs one device out. Its refresh token is revoked, and rotating the security stamp ends its
    /// access token now, as sign-out does; the other devices recover silently with their own cookies.
    /// </summary>
    [HttpDelete("sessions/{id:guid}")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> EndSession(Guid id, CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var user = userId is null ? null : await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        var current = (await _refreshTokens.ListActiveAsync(user.Id, Request.Cookies[RefreshCookieName], ct))
            .Any(s => s.Id == id && s.Current);
        if (!await _refreshTokens.RevokeSessionAsync(user.Id, id, ct))
        {
            return NotFound();
        }

        await _userManager.UpdateSecurityStampAsync(user);
        if (current)
        {
            ClearRefreshCookie();
        }
        return NoContent();
    }

    /// <summary>Signs the login out on every device, this one included.</summary>
    [HttpPost("sign-out-everywhere")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> SignOutEverywhere(CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var user = userId is null ? null : await _userManager.FindByIdAsync(userId);
        if (user is null)
        {
            return Unauthorized();
        }

        await _refreshTokens.RevokeAllForUserAsync(user.Id, ct);
        await _userManager.UpdateSecurityStampAsync(user);
        ClearRefreshCookie();
        return NoContent();
    }

    /// <summary>
    /// Emails a password-reset link if (and only if) an account exists for the address. Always 204,
    /// in the same shape and on the same path — and the lookup + provider send run OFF the request
    /// path (see <see cref="DispatchResetEmail"/>), so the response is also constant-TIME: a real
    /// and an unknown address are indistinguishable by both body and latency, closing the timing
    /// side-channel a synchronous send would open. (Account existence is still learnable from the
    /// register endpoint's duplicate-email message — an accepted, separate trade-off.)
    /// </summary>
    [HttpPost("forgot-password")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public IActionResult ForgotPassword(ForgotPasswordRequest request)
    {
        DispatchResetEmail(request.Email);
        return NoContent();
    }

    /// <summary>
    /// Emails the signed-in login a link to set its password, to its own address, and says whether
    /// the email went out. It is how a direct-invite login still on its temporary password asks for
    /// the link again (so the one thing it may call besides /auth/me); unlike forgot-password it
    /// reveals nothing about other addresses, so it can report a failed send (#298 R2-P2-1).
    /// </summary>
    [HttpPost("password-link")]
    [Authorize]
    [AllowWhilePasswordChangePending]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> SendPasswordLink(CancellationToken ct)
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        var user = userId is null ? null : await _userManager.FindByIdAsync(userId);
        if (user?.Email is null)
        {
            return Unauthorized();
        }

        return await _accountEmails.TrySendPasswordLinkAsync(user.Email, ct)
            ? NoContent()
            : StatusCode(StatusCodes.Status503ServiceUnavailable,
                new { error = "We couldn't send the email just now. Try again later." });
    }

    /// <summary>
    /// Sends the reset email as detached, best-effort work, deliberately NOT awaited by the request
    /// (<see cref="AccountEmails"/>): the response must not depend on, or be timed against, the
    /// provider round-trip. A login still on an owner-set temporary password gets the "choose your
    /// password" wording, which is also how such a login asks for its link again.
    /// </summary>
    private void DispatchResetEmail(string email) => _accountEmails.SendPasswordLink(email);

    /// <summary>
    /// Redeems an emailed reset token and sets a new password. Like change-password, this ends the
    /// session on every other device (refresh tokens revoked; the stamp rotation inside
    /// ResetPasswordAsync kills issued access tokens) and signs this device in directly — the user
    /// just proved control of the account's email, which is exactly what a sign-in would test.
    /// </summary>
    [HttpPost("reset-password")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> ResetPassword(ResetPasswordRequest request, CancellationToken ct)
    {
        const string invalidLink = "That reset link is invalid or has expired. Please request a new one.";

        // Unknown email gets the same message as a bad token — the reset endpoint must not
        // become the enumeration oracle that forgot-password carefully avoids being.
        var user = await _userManager.FindByEmailAsync(request.Email);
        if (user is null)
        {
            return BadRequest(new { error = invalidLink });
        }

        var result = await _userManager.ResetPasswordAsync(user, request.Token, request.NewPassword);
        if (!result.Succeeded)
        {
            // A dead token and a weak password both land here; only the password feedback is
            // useful to a legitimate user, so keep the token failure generic.
            if (result.Errors.Any(e => e.Code == nameof(IdentityErrorDescriber.InvalidToken)))
            {
                return BadRequest(new { error = invalidLink });
            }

            return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
        }

        // A reset proves control of the account's email, so clear any active lockout. Otherwise a
        // user who reset BECAUSE they'd locked themselves out (5 failed sign-ins → 15-min lockout,
        // the most common reset trigger) would find the correct NEW password still refused as
        // "temporarily locked" on their other devices for the rest of the window.
        await _userManager.SetLockoutEndDateAsync(user, null);
        await _userManager.ResetAccessFailedCountAsync(user);

        // Redeeming an emailed link proves control of the address, so confirm it. This is what
        // makes forgot-password double as the safe-RECLAIM of a pre-hijack squat: the true owner
        // resets, and the account is now verified + password-rotated + sessions revoked. The new
        // password is the login's own, so a temporary one set by an owner is no longer pending.
        if (!user.EmailConfirmed || user.MustChangePassword)
        {
            user.EmailConfirmed = true;
            user.MustChangePassword = false;
            await _userManager.UpdateAsync(user);
        }

        await _refreshTokens.RevokeAllForUserAsync(user.Id, ct);
        // The emailed link proves the inbox, not the person: a login with a passkey still answers it
        // (or a recovery code) before this device signs in, so a reset never switches it off (fix 14).
        return await SignInOrAskForPasskeyAsync(user, ct);
    }

    /// <summary>
    /// Changes the authenticated login's own password. Ends the session on every other device
    /// (all refresh tokens revoked; the stamp rotation inside ChangePasswordAsync kills their
    /// access tokens too) and returns a fresh token + cookie so this device stays signed in.
    /// </summary>
    [HttpPost("change-password")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> ChangePassword(ChangePasswordRequest request, CancellationToken ct)
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

        // A temporary password was chosen by whoever invited this login, so knowing it proves
        // nothing: the login's own password is set only through the link emailed to its address
        // (review P2-1 of #298). The gate already refuses this endpoint; this holds if it ever doesn't.
        if (user.MustChangePassword)
        {
            return BadRequest(new { errors = new[] { $"Choose your password with the link emailed to {user.Email}." } });
        }

        // "Changing" a password to itself is never a real change.
        if (string.Equals(request.CurrentPassword, request.NewPassword, StringComparison.Ordinal))
        {
            return BadRequest(new { errors = new[] { "Choose a new password that is different from your current one." } });
        }

        var result = await _userManager.ChangePasswordAsync(user, request.CurrentPassword, request.NewPassword);
        if (!result.Succeeded)
        {
            return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
        }

        await _refreshTokens.RevokeAllForUserAsync(user.Id, ct);
        await IssueRefreshCookieAsync(user.Id, ct);
        return Ok(await BuildResponseAsync(user, ct));
    }

    /// <summary>What deleting the signed-in login would take with it, for the confirmation.</summary>
    [HttpGet("delete-preview")]
    [Authorize]
    [ProducesResponseType(typeof(DeleteAccountPreviewResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> DeletePreview([FromServices] AccountDeletion deletion, CancellationToken ct)
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

        var preview = await deletion.PreviewAsync(userId, ct);
        return Ok(new DeleteAccountPreviewResponse(preview.OwnsHousehold, preview.OthersInHousehold, await _userManager.HasPasswordAsync(user)));
    }

    /// <summary>
    /// Deletes the signed-in login for good (compliance fix 5): its own household and everything in
    /// it, its private accounts in households it joined (erased as P59's "Keep shared" erase does, so
    /// no one else's figure changes), its access there, and its sign-in. A login with a password
    /// confirms with it; a Google-only login types its email. Refused (409) while other logins have
    /// access to its own household: the owner removes them first (#370 review P2-1). Ends the session
    /// here; every other device's token fails its next check (no user). A login whose password
    /// someone else set can't do this until it has chosen its own (S-P2-3).
    /// </summary>
    [HttpPost("delete-account")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<IActionResult> DeleteAccount(
        DeleteAccountRequest request, [FromServices] AccountDeletion deletion, CancellationToken ct)
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

        if (await _userManager.HasPasswordAsync(user))
        {
            // Proof it is the login's owner at the keyboard, not just an unlocked session (#370 review P3-1).
            if (string.IsNullOrEmpty(request.Password) || !await _userManager.CheckPasswordAsync(user, request.Password))
            {
                return BadRequest(new { error = "That password isn't right." });
            }
        }
        else if (!string.Equals(request.ConfirmEmail?.Trim(), user.Email, StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest(new { error = "That isn't your email. Type it exactly to delete your account." });
        }

        if (!await deletion.DeleteAsync(userId, ct))
        {
            return Conflict(new { error = DeleteRefusedWhileShared });
        }
        _logger.LogInformation("Account {UserId} was deleted by its own login.", userId);
        ClearRefreshCookie();
        return NoContent();
    }

    public const string DeleteRefusedWhileShared = "Others share your budget. Remove them in People first.";

    /// <summary>The authenticated login's identity, household and access level.</summary>
    [HttpGet("me")]
    [Authorize]
    [AllowWhilePasswordChangePending]
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
            households,
            NeedsConsent: user.ConsentedUtc is null,
            // Google-created accounts have no PasswordHash: the client hides change-password and
            // points at forgot-password (which SETS a password) to add one later.
            HasPassword: await _userManager.HasPasswordAsync(user),
            // Whether a Google identity is linked — drives the account page's "Connected accounts"
            // row (Disconnect) and guards against removing the login's ONLY sign-in method.
            HasGoogle: await HasGoogleLinkAsync(user),
            // Drives the persistent "confirm your email" banner. Google-created accounts are
            // confirmed on creation; password/invite accounts confirm via the emailed link.
            EmailConfirmed: user.EmailConfirmed,
            // S-P2-3: the password was set by someone else; the app asks for a new one before anything else.
            MustChangePassword: user.MustChangePassword,
            // Rule 32: the app asks this login to review who sees the personal accounts it holds.
            SharingReviewPending: await SharingReview.IsDueAsync(_db, _currentUser, HttpContext.RequestAborted),
            // Rule 85: the active household's one currency labels all its money, whatever this
            // login's own preference; the preference only seeds a household that has nothing yet.
            BudgetCurrency: (await BudgetCurrency.ResolveAsync(_db, _identity, activeOwnerId, HttpContext.RequestAborted)).Value,
            // The preference is about the login's OWN household (the one it seeds), so the lock
            // and the currency it is locked to are judged there, as the preference save is; a
            // member viewing another household sees that household's label above and their own
            // lock here (#278 P3-5, #287 review P2-4).
            CurrencyLocked: await BudgetCurrency.IsFixedAsync(_db, userId, HttpContext.RequestAborted),
            OwnBudgetCurrency: (await BudgetCurrency.ResolveAsync(_db, _identity, userId, HttpContext.RequestAborted)).Value));
    }

    private async Task<bool> HasGoogleLinkAsync(ApplicationUser user) =>
        (await _userManager.GetLoginsAsync(user)).Any(l => l.LoginProvider == "Google");

    /// <summary>
    /// Records the signed-in login's acceptance of the terms + privacy policy. Registration and
    /// invite-link acceptance record consent up front; this covers logins created FOR someone
    /// (owner-set temporary password), who consent on their first sign-in instead.
    /// </summary>
    [HttpPost("consent")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Consent()
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

        if (user.ConsentedUtc is null)
        {
            user.ConsentedUtc = DateTime.UtcNow;
            var result = await _userManager.UpdateAsync(user);
            if (!result.Succeeded)
            {
                return BadRequest(new { errors = result.Errors.Select(e => e.Description) });
            }
        }

        return NoContent();
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
            .Select(u => new { u.Id, u.DisplayName })
            .ToDictionaryAsync(u => u.Id, ct);

        var households = memberships
            .Select(m =>
            {
                var isOwn = m.OwnerId == userId;
                owners.TryGetValue(m.OwnerId, out var owner);
                // Never the owner's email: a household is named by its owner's name, else
                // generically (S-P3-9).
                var label = isOwn ? "Your household"
                    : owner?.DisplayName is { } name && !string.IsNullOrWhiteSpace(name) ? name : "Household";
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
        // The preference is this login's own household's budget currency (rule 85). Once that
        // household holds an account, a month or a transaction, changing it would relabel money
        // already recorded — an implicit 1:1 conversion (rule 42).
        if (!string.Equals(currency, user.PreferredCurrency, StringComparison.Ordinal)
            && await BudgetCurrency.IsFixedAsync(_db, userId, HttpContext.RequestAborted))
        {
            var budgetCurrency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, HttpContext.RequestAborted);
            return BadRequest(new
            {
                error = $"Your budget is in {budgetCurrency.Value} and already has accounts, months or transactions, so its currency can't be changed.",
            });
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

    /// <summary>Starts a sign-in on this device: a fresh refresh token, written to the HttpOnly cookie.</summary>
    private async Task IssueRefreshCookieAsync(string userId, CancellationToken ct)
    {
        // The cookie being replaced ends with it, or its sign-in lingers as a second row for this
        // device (disconnecting Google, signing in again over a cookie still set).
        var replaced = Request.Cookies[RefreshCookieName];
        if (!string.IsNullOrEmpty(replaced))
        {
            await _refreshTokens.RevokeAsync(replaced, ct);
        }

        var raw = await _refreshTokens.IssueAsync(userId, CurrentDevice(), ct);
        SetRefreshCookie(raw);
    }

    /// <summary>
    /// Keeps this device's sign-in going under a new cookie, after a change that needs a fresh access
    /// token but proved nothing (disconnecting Google, accepting an invite while signed in). The
    /// sign-in keeps its start, so it counts as recent only if it was, and its 90-day cap holds.
    /// No cookie, or one that no longer works, gets none: a bare access token never starts a sign-in.
    /// </summary>
    private async Task ContinueRefreshCookieAsync(string userId, CancellationToken ct)
    {
        var current = Request.Cookies[RefreshCookieName];
        if (string.IsNullOrEmpty(current))
        {
            return;
        }

        // Only this login's own sign-in carries on: another login's cookie on this browser is left
        // alone, as rotating it would end that sign-in and set off theft detection on its next use.
        var sessions = await _refreshTokens.ListActiveAsync(userId, current, ct);
        if (!sessions.Any(s => s.Current))
        {
            return;
        }

        var rotated = await _refreshTokens.RotateAsync(current, CurrentDevice(), ct);
        if (!rotated.Succeeded || rotated.UserId != userId)
        {
            return;
        }
        SetRefreshCookie(rotated.NewRawToken!, rotated.ExpiresUtc);
    }

    /// <summary>The device this request comes from, as the list of signed-in devices names it.</summary>
    private string? CurrentDevice() =>
        DeviceName.From(Request.Headers.UserAgent.ToString(), Request.Headers[DeviceName.AppHeader] == "1");

    private void SetRefreshCookie(string rawToken, DateTime? expiresUtc = null) =>
        Response.Cookies.Append(RefreshCookieName, rawToken, new CookieOptions
        {
            HttpOnly = true,
            // Secure requires HTTPS, which we always have in prod (Cloudflare); local dev is plain http.
            Secure = !_env.IsDevelopment(),
            SameSite = SameSiteMode.Strict,
            Path = "/api/auth",
            Expires = expiresUtc is { } at
                ? new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc))
                : DateTimeOffset.UtcNow.AddDays(RefreshTokenService.LifetimeDays),
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
        // The role in the household the login acts in, not in whichever membership comes first (S-P3-5).
        var role = await ActiveHouseholdSelector.ActiveRoleAsync(_db, user.Id, user.ActiveOwnerId, ct);

        var stamp = await _userManager.GetSecurityStampAsync(user);
        var (token, expiresAt) = _tokenGenerator.Generate(user.Id, user.Email!, stamp);
        return new AuthResponse(token, expiresAt, user.Id, user.Email!, role, user.DisplayName);
    }
}
