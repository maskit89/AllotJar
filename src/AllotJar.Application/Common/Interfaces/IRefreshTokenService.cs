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
    /// Presenting an already-rotated token is treated as theft and revokes the whole chain — unless
    /// the rotation happened moments ago (concurrent tabs racing the same cookie), which is refused
    /// without the theft response.
    /// </summary>
    Task<RefreshRotationResult> RotateAsync(string rawToken, CancellationToken cancellationToken = default);

    /// <summary>
    /// Revokes a refresh token (sign-out). Returns the owning user id when the token is known
    /// (even if already revoked, so sign-out can still invalidate access tokens), else null.
    /// </summary>
    Task<string?> RevokeAsync(string rawToken, CancellationToken cancellationToken = default);

    /// <summary>Revokes every active refresh token a login holds — ends the session on all devices.</summary>
    Task RevokeAllForUserAsync(string userId, CancellationToken cancellationToken = default);
}

/// <summary>Outcome of a rotation. On success carries the user id and the new raw token for the cookie.</summary>
public record RefreshRotationResult(bool Succeeded, string? UserId, string? NewRawToken)
{
    /// <summary>
    /// True when the token was refused because a concurrent sibling request just rotated it.
    /// Not a sign-out: the caller's cookie jar already holds the sibling's fresh token, so the
    /// controller must NOT clear the cookie on this failure.
    /// </summary>
    public bool Superseded { get; init; }

    public static readonly RefreshRotationResult Failed = new(false, null, null);

    /// <summary>Refused without the theft response — the token was rotated within the grace window.</summary>
    public static readonly RefreshRotationResult SupersededRecently = new(false, null, null) { Superseded = true };

    public static RefreshRotationResult Success(string userId, string newRawToken) =>
        new(true, userId, newRawToken);
}
