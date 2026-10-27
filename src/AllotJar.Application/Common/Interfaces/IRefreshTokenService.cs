namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Issues, rotates and revokes the long-lived refresh tokens that back the HttpOnly-cookie session.
/// The raw token is returned to the caller (to put in the cookie) and only ever stored hashed.
/// </summary>
public interface IRefreshTokenService
{
    /// <summary>
    /// Starts a sign-in: mints a new refresh token for a login and returns the raw value (store it in
    /// the cookie). <paramref name="device"/> names the device for the list of signed-in devices.
    /// </summary>
    Task<string> IssueAsync(string userId, string? device = null, CancellationToken cancellationToken = default);

    /// <summary>
    /// Validates a presented refresh token and, if good, rotates it (revokes the old, issues a new).
    /// Presenting an already-rotated token is treated as theft and revokes the whole chain — unless
    /// the rotation happened moments ago (concurrent tabs racing the same cookie), which is refused
    /// without the theft response. A sign-in older than its maximum age is refused too, and so is a
    /// token that a sign-out (or the purge) reached between reading and rotating it.
    /// </summary>
    Task<RefreshRotationResult> RotateAsync(string rawToken, string? device = null, CancellationToken cancellationToken = default);

    /// <summary>
    /// Call once a successful rotation is committed, before handing out its token. False when a
    /// sign-out of the same sign-in landed at the same moment: the sign-out wins, the new token is
    /// revoked, and the caller must refuse the refresh. Rotation runs inside the caller's
    /// transaction, so this check can only be made after it commits.
    /// </summary>
    Task<bool> ConfirmAsync(string newRawToken, CancellationToken cancellationToken = default);

    /// <summary>
    /// Signs out the sign-in a refresh token belongs to (every token of it, so one a racing refresh
    /// has just minted too). Returns the owning user id when the token is known (even if already
    /// revoked, so sign-out can still invalidate access tokens), else null.
    /// </summary>
    Task<string?> RevokeAsync(string rawToken, CancellationToken cancellationToken = default);

    /// <summary>Revokes every active refresh token a login holds — ends the session on all devices.</summary>
    Task RevokeAllForUserAsync(string userId, CancellationToken cancellationToken = default);

    /// <summary>
    /// The login's sign-ins still in force, one per device, the one holding
    /// <paramref name="currentRawToken"/> marked current and listed first.
    /// </summary>
    Task<IReadOnlyList<ActiveSession>> ListActiveAsync(string userId, string? currentRawToken, CancellationToken cancellationToken = default);

    /// <summary>Ends one of the login's sign-ins. False when it has none by that id still in force.</summary>
    Task<bool> RevokeSessionAsync(string userId, Guid sessionId, CancellationToken cancellationToken = default);
}

/// <summary>One sign-in still in force: the device it was made on, when it began and last refreshed.</summary>
public record ActiveSession(Guid Id, string? Device, DateTime StartedUtc, DateTime LastActiveUtc, bool Current);

/// <summary>Outcome of a rotation. On success carries the user id and the new raw token for the cookie.</summary>
public record RefreshRotationResult(bool Succeeded, string? UserId, string? NewRawToken)
{
    /// <summary>When the new token expires (its cookie should expire with it). Set on success.</summary>
    public DateTime? ExpiresUtc { get; init; }

    /// <summary>
    /// True when the token was refused because a concurrent sibling request just rotated it.
    /// Not a sign-out: the caller's cookie jar already holds the sibling's fresh token, so the
    /// controller must NOT clear the cookie on this failure.
    /// </summary>
    public bool Superseded { get; init; }

    public static readonly RefreshRotationResult Failed = new(false, null, null);

    /// <summary>Refused without the theft response — the token was rotated within the grace window.</summary>
    public static readonly RefreshRotationResult SupersededRecently = new(false, null, null) { Superseded = true };

    public static RefreshRotationResult Success(string userId, string newRawToken, DateTime expiresUtc) =>
        new(true, userId, newRawToken) { ExpiresUtc = expiresUtc };
}
