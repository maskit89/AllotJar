namespace AllotJar.Domain.Entities;

/// <summary>
/// A long-lived refresh token that lets a login mint short-lived access tokens without re-entering
/// credentials. Issued on sign-in and rotated on every use. Only the SHA-256 hash is stored — the
/// raw value lives solely in the caller's HttpOnly cookie, so a leaked DB row can't be replayed.
/// </summary>
public class RefreshToken
{
    public Guid Id { get; set; }

    /// <summary>The ASP.NET Identity user this token authenticates.</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>Hex SHA-256 of the raw token; the raw value is never persisted.</summary>
    public string TokenHash { get; set; } = string.Empty;

    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }

    /// <summary>Set when the token is rotated on use, or revoked (logout / theft response).</summary>
    public DateTime? RevokedUtc { get; set; }

    /// <summary>Hash of the token that superseded this one on rotation — enables reuse detection.</summary>
    public string? ReplacedByTokenHash { get; set; }
}
