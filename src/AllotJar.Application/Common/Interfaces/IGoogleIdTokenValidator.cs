namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// The identity attested by a verified Google ID token. <see cref="Subject"/> is Google's
/// permanent, never-reused account id (`sub`) — the ONLY value safe to key an account link on
/// (emails can change or be recycled). <see cref="EmailVerified"/> is Google's own attestation;
/// account auto-linking must require it, or an attacker could mint a Google account claiming a
/// victim's unverified address and walk into their AllotJar account.
/// </summary>
public sealed record GoogleIdentity(
    string Subject,
    string Email,
    bool EmailVerified,
    string? GivenName,
    string? FamilyName,
    string? DisplayName);

/// <summary>
/// Verifies a Google Sign-In ID token (the `credential` the Google Identity Services button hands
/// the client) and returns the attested identity, or <c>null</c> when the token is invalid —
/// bad signature, wrong audience, expired, malformed. Implementations: the real
/// Google-public-key validator in production, and a Development-only fake so the test harnesses
/// can drive the flow without Google credentials (same pattern as IEmailSender's providers).
/// </summary>
public interface IGoogleIdTokenValidator
{
    Task<GoogleIdentity?> ValidateAsync(string idToken, CancellationToken ct = default);
}
