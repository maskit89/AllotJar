using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Api.Contracts.Auth;
using AllotJar.Infrastructure.Email;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Api.Controllers;

/// <summary>
/// Two-factor sign-in with passkeys (compliance fix 14). A passkey is the device's own unlock
/// (fingerprint, face or PIN) or a password manager, through the WebAuthn standard, so it is two
/// factors on its own: "Sign in with a passkey" needs nothing else. Once a login has one, a password,
/// Google or reset-link sign-in starts no session until the passkey, or one of the login's recovery
/// codes, answers too. A password reset does not switch it off: an inbox alone never gets past it.
/// </summary>
public partial class AuthController
{
    /// <summary>Signing in this recently counts as proof for changing passkeys, so turning one on just after signing in asks nothing more.</summary>
    public static readonly TimeSpan RecentSignIn = TimeSpan.FromMinutes(10);

    /// <summary>A login holds at most this many passkeys.</summary>
    public const int MaxPasskeys = 10;

    private const string PasskeyFailed = "That passkey didn't work. Try again.";
    private const string StartAgain = "That took too long. Sign in again.";

    /// <summary>
    /// Ends a password, Google or reset sign-in: this device's session, or, for a login with a
    /// passkey, the second step to answer first.
    /// </summary>
    private async Task<IActionResult> SignInOrAskForPasskeyAsync(
        ApplicationUser user, CancellationToken ct, Func<AuthResponse, AuthResponse>? shape = null)
    {
        var passkeys = HttpContext.RequestServices.GetRequiredService<IPasskeyHandler<ApplicationUser>>();
        if ((await _userManager.GetPasskeysAsync(user)).Count > 0)
        {
            var request = await passkeys.MakeRequestOptionsAsync(user, HttpContext);
            var ticket = Ceremonies.Start(PasskeyCeremonyKind.SecondStep, user.Id, request.AssertionState);
            return Ok(new SecondStepResponse(true, ticket, request.RequestOptionsJson));
        }

        await IssueRefreshCookieAsync(user.Id, ct);
        var response = await BuildResponseAsync(user, ct);
        return Ok(shape is null ? response : shape(response));
    }

    private PasskeyCeremonies Ceremonies => HttpContext.RequestServices.GetRequiredService<PasskeyCeremonies>();

    // --- Signing in ---------------------------------------------------------------------------

    /// <summary>Starts "Sign in with a passkey": options naming no login, so the device offers its AllotJar passkeys.</summary>
    [HttpPost("passkey-sign-in/options")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(PasskeyCeremonyResponse), StatusCodes.Status200OK)]
    public async Task<IActionResult> PasskeySignInOptions([FromServices] IPasskeyHandler<ApplicationUser> passkeys)
    {
        var request = await passkeys.MakeRequestOptionsAsync(null, HttpContext);
        return Ok(new PasskeyCeremonyResponse(
            Ceremonies.Start(PasskeyCeremonyKind.SignIn, null, request.AssertionState), request.RequestOptionsJson));
    }

    /// <summary>
    /// Signs in with a passkey alone. Like Google sign-in, it ignores password lockout: lockout slows
    /// password guessing, and a passkey that answers is proof no guess can give.
    /// </summary>
    [HttpPost("passkey-sign-in")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> PasskeySignIn(
        PasskeyAnswerRequest request, [FromServices] IPasskeyHandler<ApplicationUser> passkeys, CancellationToken ct)
    {
        var ceremony = Ceremonies.Find(request.Ceremony, PasskeyCeremonyKind.SignIn);
        if (ceremony is null)
        {
            return Unauthorized(new { error = StartAgain });
        }

        var result = await passkeys.PerformAssertionAsync(new PasskeyAssertionContext
        {
            HttpContext = HttpContext, CredentialJson = request.Credential, AssertionState = ceremony.State,
        });
        // One answer per ceremony, right or wrong: the next try starts a new one.
        if (!Ceremonies.TryTake(request.Ceremony) || !result.Succeeded)
        {
            LogPasskeyFailure("sign-in", result.Failure);
            return Unauthorized(new { error = "That passkey isn't one AllotJar knows. Sign in another way, then add it in Account settings." });
        }

        await _userManager.AddOrUpdatePasskeyAsync(result.User, result.Passkey);
        await IssueRefreshCookieAsync(result.User.Id, ct);
        return Ok(await BuildResponseAsync(result.User, ct));
    }

    /// <summary>The second step with the passkey: the session starts once it answers for the login the ticket is for.</summary>
    [HttpPost("second-step/passkey")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> SecondStepPasskey(
        SecondStepPasskeyRequest request, [FromServices] IPasskeyHandler<ApplicationUser> passkeys, CancellationToken ct)
    {
        var ceremony = Ceremonies.Find(request.Ticket, PasskeyCeremonyKind.SecondStep);
        if (ceremony is null)
        {
            return Unauthorized(new { error = StartAgain, restart = true });
        }

        var result = await passkeys.PerformAssertionAsync(new PasskeyAssertionContext
        {
            HttpContext = HttpContext, CredentialJson = request.Credential, AssertionState = ceremony.State,
        });
        if (!result.Succeeded || result.User.Id != ceremony.UserId)
        {
            LogPasskeyFailure("second step", result.Failure);
            Ceremonies.Fail(request.Ticket);
            return Unauthorized(new { error = PasskeyFailed });
        }
        if (!Ceremonies.TryTake(request.Ticket))
        {
            return Unauthorized(new { error = StartAgain, restart = true });
        }

        await _userManager.AddOrUpdatePasskeyAsync(result.User, result.Passkey);
        await IssueRefreshCookieAsync(result.User.Id, ct);
        return Ok(await BuildResponseAsync(result.User, ct));
    }

    /// <summary>The second step with a recovery code instead, for when the passkey's device is lost. The code is used up.</summary>
    [HttpPost("second-step/recovery-code")]
    [AllowAnonymous]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AuthResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> SecondStepRecoveryCode(
        SecondStepRecoveryCodeRequest request, [FromServices] RecoveryCodes codes, CancellationToken ct)
    {
        var ceremony = Ceremonies.Find(request.Ticket, PasskeyCeremonyKind.SecondStep);
        var user = ceremony?.UserId is { } userId ? await _userManager.FindByIdAsync(userId) : null;
        if (ceremony is null || user is null)
        {
            return Unauthorized(new { error = StartAgain, restart = true });
        }

        if (!await codes.RedeemAsync(user, request.Code))
        {
            Ceremonies.Fail(request.Ticket);
            return Unauthorized(new { error = "That code isn't right, or it was used already." });
        }
        if (!Ceremonies.TryTake(request.Ticket))
        {
            return Unauthorized(new { error = StartAgain, restart = true });
        }

        _accountEmails.SendPasskeyNotice(user.Email!, PasskeyNotice.RecoveryCodeUsed, CurrentDevice());
        await IssueRefreshCookieAsync(user.Id, ct);
        return Ok(await BuildResponseAsync(user, ct));
    }

    // --- The login's own passkeys ---------------------------------------------------------------

    /// <summary>The login's passkeys, newest first, and how many recovery codes it has left.</summary>
    [HttpGet("passkeys")]
    [Authorize]
    [ProducesResponseType(typeof(PasskeysResponse), StatusCodes.Status200OK)]
    public async Task<IActionResult> Passkeys([FromServices] RecoveryCodes codes)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }

        var list = (await _userManager.GetPasskeysAsync(user))
            .OrderByDescending(p => p.CreatedAt)
            .Select(ToResponse)
            .ToList();
        return Ok(new PasskeysResponse(list, list.Count == 0 ? 0 : await codes.CountAsync(user)));
    }

    /// <summary>Options for proving it is the owner with one of the login's own passkeys (see <see cref="PasskeyProof"/>).</summary>
    [HttpPost("passkeys/proof-options")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(PasskeyCeremonyResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> PasskeyProofOptions([FromServices] IPasskeyHandler<ApplicationUser> passkeys)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }
        if ((await _userManager.GetPasskeysAsync(user)).Count == 0)
        {
            return BadRequest(new { error = "You don't have a passkey yet." });
        }

        var request = await passkeys.MakeRequestOptionsAsync(user, HttpContext);
        return Ok(new PasskeyCeremonyResponse(
            Ceremonies.Start(PasskeyCeremonyKind.Proof, user.Id, request.AssertionState), request.RequestOptionsJson));
    }

    /// <summary>Starts adding a passkey: creation options for the device, once the owner has proved it is them.</summary>
    [HttpPost("passkeys/options")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(PasskeyCeremonyResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> AddPasskeyOptions(
        PasskeyProofRequest request, [FromServices] IPasskeyHandler<ApplicationUser> passkeys, CancellationToken ct)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }
        if ((await _userManager.GetPasskeysAsync(user)).Count >= MaxPasskeys)
        {
            return BadRequest(new { error = $"You have {MaxPasskeys} passkeys already. Remove one first." });
        }
        if (await RefuseWithoutProofAsync(user, request.Proof, ct) is { } refused)
        {
            return refused;
        }

        var creation = await passkeys.MakeCreationOptionsAsync(new PasskeyUserEntity
        {
            Id = user.Id,
            Name = user.Email!,
            DisplayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.Email! : user.DisplayName,
        }, HttpContext);
        return Ok(new PasskeyCeremonyResponse(
            Ceremonies.Start(PasskeyCeremonyKind.Register, user.Id, creation.AttestationState), creation.CreationOptionsJson));
    }

    /// <summary>
    /// Saves the passkey the device made, named after the device. The first one comes with the
    /// login's recovery codes, shown this once. The other devices stay signed in; the owner can sign
    /// them out in the Devices card.
    /// </summary>
    [HttpPost("passkeys")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(AddPasskeyResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> AddPasskey(
        PasskeyAnswerRequest request,
        [FromServices] IPasskeyHandler<ApplicationUser> passkeys,
        [FromServices] RecoveryCodes codes)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }

        var ceremony = Ceremonies.Find(request.Ceremony, PasskeyCeremonyKind.Register);
        if (ceremony is null || ceremony.UserId != user.Id)
        {
            return BadRequest(new { error = "That took too long. Try again." });
        }

        var result = await passkeys.PerformAttestationAsync(new PasskeyAttestationContext
        {
            HttpContext = HttpContext, CredentialJson = request.Credential, AttestationState = ceremony.State,
        });
        if (!Ceremonies.TryTake(request.Ceremony) || !result.Succeeded || result.UserEntity.Id != user.Id)
        {
            LogPasskeyFailure("adding", result.Failure);
            return BadRequest(new { error = "The passkey wasn't saved. Try again." });
        }

        var passkey = result.Passkey;
        passkey.Name = CurrentDevice() ?? "Passkey";
        var saved = await _userManager.AddOrUpdatePasskeyAsync(user, passkey);
        if (!saved.Succeeded)
        {
            return BadRequest(new { error = "The passkey wasn't saved. Try again." });
        }

        // Counted after saving, so two first adds racing in two tabs can't both make codes.
        var first = (await _userManager.GetPasskeysAsync(user)).Count == 1;

        var recoveryCodes = first ? await codes.ReplaceAsync(user) : null;
        _accountEmails.SendPasskeyNotice(user.Email!, PasskeyNotice.Added, passkey.Name);
        return Ok(new AddPasskeyResponse(ToResponse(passkey), recoveryCodes));
    }

    /// <summary>Removes one of the login's passkeys. Removing the last switches the second step off and voids the recovery codes.</summary>
    [HttpPost("passkeys/{id}/remove")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> RemovePasskey(
        string id, PasskeyProofRequest request, [FromServices] RecoveryCodes codes, CancellationToken ct)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }

        var credentialId = FromBase64Url(id);
        var passkey = credentialId is null ? null : await _userManager.GetPasskeyAsync(user, credentialId);
        if (passkey is null)
        {
            return NotFound();
        }
        if (await RefuseWithoutProofAsync(user, request.Proof, ct) is { } refused)
        {
            return refused;
        }

        await _userManager.RemovePasskeyAsync(user, passkey.CredentialId);
        if ((await _userManager.GetPasskeysAsync(user)).Count == 0)
        {
            await codes.ClearAsync(user);
        }
        _accountEmails.SendPasskeyNotice(user.Email!, PasskeyNotice.Removed, passkey.Name);
        return NoContent();
    }

    /// <summary>A fresh set of recovery codes, voiding the old ones.</summary>
    [HttpPost("passkeys/recovery-codes")]
    [Authorize]
    [EnableRateLimiting("auth")]
    [ProducesResponseType(typeof(RecoveryCodesResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    public async Task<IActionResult> ReplaceRecoveryCodes(
        PasskeyProofRequest request, [FromServices] RecoveryCodes codes, CancellationToken ct)
    {
        var user = await SignedInUserAsync();
        if (user is null)
        {
            return Unauthorized();
        }
        if ((await _userManager.GetPasskeysAsync(user)).Count == 0)
        {
            return BadRequest(new { error = "Recovery codes come with a passkey. Add one first." });
        }
        if (await RefuseWithoutProofAsync(user, request.Proof, ct) is { } refused)
        {
            return refused;
        }

        var replaced = await codes.ReplaceAsync(user);
        _accountEmails.SendPasskeyNotice(user.Email!, PasskeyNotice.RecoveryCodesReplaced, CurrentDevice());
        return Ok(new RecoveryCodesResponse(replaced));
    }

    // --- Helpers --------------------------------------------------------------------------------

    private async Task<ApplicationUser?> SignedInUserAsync()
    {
        var userId = User.FindFirstValue(ClaimTypes.NameIdentifier);
        return userId is null ? null : await _userManager.FindByIdAsync(userId);
    }

    /// <summary>
    /// Null when the owner has proved it is them: by signing in on this device within
    /// <see cref="RecentSignIn"/>, its password, one of its passkeys, or a recovery code (used up).
    /// Otherwise a 403 saying which proofs this login can give, so an unlocked device left signed in
    /// can't add a stranger's passkey (which would lock the owner out) or remove the owner's.
    /// </summary>
    private async Task<IActionResult?> RefuseWithoutProofAsync(ApplicationUser user, PasskeyProof? proof, CancellationToken ct)
    {
        var current = (await _refreshTokens.ListActiveAsync(user.Id, Request.Cookies[RefreshCookieName], ct))
            .FirstOrDefault(s => s.Current);
        if (current is not null
            && (DateTime.UtcNow - current.StartedUtc <= RecentSignIn || Ceremonies.HasProof(user.Id, current.Id)))
        {
            return null;
        }

        var hasPassword = await _userManager.HasPasswordAsync(user);
        var hasPasskey = (await _userManager.GetPasskeysAsync(user)).Count > 0;

        if (!string.IsNullOrEmpty(proof?.Password) && hasPassword)
        {
            if (!await _userManager.IsLockedOutAsync(user) && await _userManager.CheckPasswordAsync(user, proof.Password))
            {
                await _userManager.ResetAccessFailedCountAsync(user);
                return Proved(user, current);
            }
            // A wrong password here counts toward lockout, as at sign-in, so this is no guessing oracle.
            await _userManager.AccessFailedAsync(user);
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "That password isn't right." });
        }

        if (!string.IsNullOrEmpty(proof?.Ceremony) && !string.IsNullOrEmpty(proof.Credential) && hasPasskey)
        {
            var ceremony = Ceremonies.Find(proof.Ceremony, PasskeyCeremonyKind.Proof);
            if (ceremony is not null && ceremony.UserId == user.Id)
            {
                var passkeys = HttpContext.RequestServices.GetRequiredService<IPasskeyHandler<ApplicationUser>>();
                var result = await passkeys.PerformAssertionAsync(new PasskeyAssertionContext
                {
                    HttpContext = HttpContext, CredentialJson = proof.Credential, AssertionState = ceremony.State,
                });
                if (Ceremonies.TryTake(proof.Ceremony) && result.Succeeded && result.User.Id == user.Id)
                {
                    await _userManager.AddOrUpdatePasskeyAsync(user, result.Passkey);
                    return Proved(user, current);
                }
                LogPasskeyFailure("proof", result.Failure);
            }
            return StatusCode(StatusCodes.Status403Forbidden, new { error = PasskeyFailed });
        }

        if (!string.IsNullOrEmpty(proof?.RecoveryCode) && hasPasskey)
        {
            var codes = HttpContext.RequestServices.GetRequiredService<RecoveryCodes>();
            if (await codes.RedeemAsync(user, proof.RecoveryCode))
            {
                _accountEmails.SendPasskeyNotice(user.Email!, PasskeyNotice.RecoveryCodeUsed, CurrentDevice());
                return Proved(user, current);
            }
            return StatusCode(StatusCodes.Status403Forbidden, new { error = "That code isn't right, or it was used already." });
        }

        return StatusCode(StatusCodes.Status403Forbidden, new
        {
            error = hasPassword || hasPasskey ? "Confirm it's you first." : "Sign in again to do this.",
            proof = new { password = hasPassword, passkey = hasPasskey, recoveryCode = hasPasskey },
        });
    }

    /// <summary>A proof was given: it holds on this sign-in for a few minutes (see <see cref="PasskeyCeremonies.GrantProof"/>).</summary>
    private IActionResult? Proved(ApplicationUser user, ActiveSession? current)
    {
        if (current is not null)
        {
            Ceremonies.GrantProof(user.Id, current.Id);
        }
        return null;
    }

    private void LogPasskeyFailure(string step, PasskeyException? failure) =>
        // The message names what failed (challenge, origin, signature); never the credential itself.
        _logger.LogInformation("A passkey {Step} was refused: {Reason}", step, failure?.Message ?? "ceremony already used");

    private static PasskeyResponse ToResponse(UserPasskeyInfo passkey) =>
        new(ToBase64Url(passkey.CredentialId), passkey.Name, passkey.CreatedAt.UtcDateTime);

    private static string ToBase64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[]? FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        base64 = base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '=');
        try
        {
            return Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            return null;
        }
    }
}
