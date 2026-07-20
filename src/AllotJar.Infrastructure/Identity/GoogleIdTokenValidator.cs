using Google.Apis.Auth;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Validates Google ID tokens against Google's published signing keys via the official
/// Google.Apis.Auth library (which caches and rotates the keys per their Cache-Control headers).
/// The audience check pins the token to OUR OAuth client id — without it, an ID token minted for
/// any other app would sign its holder into AllotJar.
/// </summary>
public class GoogleIdTokenValidator : IGoogleIdTokenValidator
{
    private readonly GoogleAuthSettings _settings;
    private readonly ILogger<GoogleIdTokenValidator> _logger;

    public GoogleIdTokenValidator(IOptions<GoogleAuthSettings> settings, ILogger<GoogleIdTokenValidator> logger)
    {
        _settings = settings.Value;
        _logger = logger;
    }

    public async Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken ct = default)
    {
        // No configured client id ⇒ no audience to pin to ⇒ nothing can validly authenticate.
        if (string.IsNullOrWhiteSpace(_settings.ClientId) || string.IsNullOrWhiteSpace(idToken))
        {
            return null;
        }

        try
        {
            var payload = await GoogleJsonWebSignature.ValidateAsync(idToken, BuildValidationSettings(_settings.ClientId));

            if (string.IsNullOrWhiteSpace(payload.Subject) || string.IsNullOrWhiteSpace(payload.Email))
            {
                return null; // never observed from Google, but an account key must never be blank
            }

            return new GoogleIdentity(
                payload.Subject,
                payload.Email,
                payload.EmailVerified,
                NullIfBlank(payload.GivenName),
                NullIfBlank(payload.FamilyName),
                NullIfBlank(payload.Name));
        }
        catch (InvalidJwtException ex)
        {
            // Expected for expired/tampered/wrong-audience tokens — a 401 for the caller, not an error.
            _logger.LogInformation("Rejected a Google ID token: {Reason}", ex.Message);
            return null;
        }
        catch (Exception ex)
        {
            // Key-fetch/network trouble. Fail CLOSED — a credential that can't be verified must
            // never sign anyone in — but log loudly since this blocks all Google sign-ins.
            _logger.LogError(ex, "Google ID token validation failed (key fetch or transport).");
            return null;
        }
    }

    private static string? NullIfBlank(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    /// <summary>
    /// The Google validation settings, pinned so the ID token's `aud` MUST equal our OAuth client
    /// id. This is the feature's core control: without it, an ID token minted for ANY Google app
    /// would sign its holder into AllotJar. Exposed so a test can assert the audience is actually
    /// wired from config — <see cref="GoogleJsonWebSignature.ValidateAsync(string, GoogleJsonWebSignature.ValidationSettings)"/>
    /// is a static call with no injectable seam, so removing the pin would otherwise go unnoticed.
    /// </summary>
    public static GoogleJsonWebSignature.ValidationSettings BuildValidationSettings(string? clientId) =>
        new() { Audience = new[] { clientId } };
}
