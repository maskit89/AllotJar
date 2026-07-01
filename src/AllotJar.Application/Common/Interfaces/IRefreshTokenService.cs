namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Issues, rotates and revokes the long-lived refresh tokens that back the HttpOnly-cookie session.
/// The raw token is returned to the caller (to put in the cookie) and only ever stored hashed.
/// </summary>
public interface IRefreshTokenService
{
    /// <summary>Mints a new refresh token for a login and returns the raw value (store it in the cookie).</summary>
    Task<string> IssueAsync(string userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Validates a presented refresh token and, if good, rotates it (revokes the old, issues a new).
    /// Presenting an already-rotated token is treated as theft and revokes the whole chain.
    /// </summary>
    Task<RefreshRotationResult> RotateAsync(string rawToken, CancellationToken cancellationToken = default);

    /// <summary>Revokes a refresh token (sign-out). No-op if it's unknown or already revoked.</summary>
    Task RevokeAsync(string rawToken, CancellationToken cancellationToken = default);
}

/// <summary>Outcome of a rotation. On success carries the user id and the new raw token for the cookie.</summary>
public record RefreshRotationResult(bool Succeeded, string? UserId, string? NewRawToken)
{
    public static readonly RefreshRotationResult Failed = new(false, null, null);

    public static RefreshRotationResult Success(string userId, string newRawToken) =>
        new(true, userId, newRawToken);
}
