using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// EF-backed refresh tokens with rotation + reuse detection. Mirrors the invite-token approach:
/// 256 bits of CSPRNG entropy, stored only as a hex SHA-256 hash.
/// </summary>
public class RefreshTokenService : IRefreshTokenService
{
    /// <summary>How long a refresh token (and its cookie) stays valid. Used by the controller too.</summary>
    public const int LifetimeDays = 30;

    /// <summary>
    /// How long after a rotation the old token may turn up again without triggering the theft
    /// response. A browser restoring several app tabs cold-loads them all at once; every tab
    /// POSTs /auth/refresh with the SAME cookie (the client single-flight is per-tab), so the
    /// losers present a token that was rotated milliseconds earlier. That race never spans more
    /// than a few seconds; a genuinely stolen cookie is replayed far later.
    /// </summary>
    public static readonly TimeSpan ReplayGraceWindow = TimeSpan.FromSeconds(30);

    private readonly ApplicationDbContext _db;

    public RefreshTokenService(ApplicationDbContext db)
    {
        _db = db;
    }

    public async Task<string> IssueAsync(string userId, CancellationToken cancellationToken = default)
    {
        await PruneExpiredAsync(userId, cancellationToken);
        var raw = Generate();
        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = userId,
            TokenHash = Hash(raw),
            CreatedUtc = DateTime.UtcNow,
            ExpiresUtc = DateTime.UtcNow.AddDays(LifetimeDays),
        });
        await _db.SaveChangesAsync(cancellationToken);
        return raw;
    }

    public async Task<RefreshRotationResult> RotateAsync(string rawToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(rawToken))
        {
            return RefreshRotationResult.Failed;
        }

        var hash = Hash(rawToken);
        var token = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null)
        {
            return RefreshRotationResult.Failed;
        }

        // A token that was ROTATED turning up again means the cookie was stolen and replayed —
        // burn every active token for the user so neither party can continue. A token revoked
        // administratively (logout, password change signs out all devices) has no replacement:
        // that's just a signed-out device checking back in, so refuse it WITHOUT the theft
        // response — otherwise a stale device would nuke the user's brand-new sessions.
        if (token.RevokedUtc is not null)
        {
            if (token.ReplacedByTokenHash is not null)
            {
                // Rotated within the grace window: a sibling request of the same browser (a
                // second restored tab) just won the race, and the cookie jar already holds its
                // replacement. Refuse this call without the theft response — and flag it so the
                // controller doesn't clear the winner's fresh cookie out of the shared jar.
                if (DateTime.UtcNow - token.RevokedUtc.Value <= ReplayGraceWindow)
                {
                    return RefreshRotationResult.SupersededRecently;
                }

                await RevokeAllForUserAsync(token.UserId, cancellationToken);
            }
            return RefreshRotationResult.Failed;
        }

        if (DateTime.UtcNow >= token.ExpiresUtc)
        {
            return RefreshRotationResult.Failed;
        }

        await PruneExpiredAsync(token.UserId, cancellationToken);
        var newRaw = Generate();
        token.RevokedUtc = DateTime.UtcNow;
        token.ReplacedByTokenHash = Hash(newRaw);
        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = token.UserId,
            TokenHash = token.ReplacedByTokenHash,
            CreatedUtc = DateTime.UtcNow,
            ExpiresUtc = DateTime.UtcNow.AddDays(LifetimeDays),
        });
        await _db.SaveChangesAsync(cancellationToken);
        return RefreshRotationResult.Success(token.UserId, newRaw);
    }

    public async Task<string?> RevokeAsync(string rawToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(rawToken))
        {
            return null;
        }

        var hash = Hash(rawToken);
        var token = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is null)
        {
            return null;
        }

        if (token.RevokedUtc is null)
        {
            token.RevokedUtc = DateTime.UtcNow;
            await _db.SaveChangesAsync(cancellationToken);
        }

        return token.UserId;
    }

    public async Task RevokeAllForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedUtc == null)
            .ToListAsync(cancellationToken);
        foreach (var t in active)
        {
            t.RevokedUtc = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync(cancellationToken);
    }

    /// <summary>
    /// Removes the login's tokens past their expiry (S-P3-1): every issue and rotation adds a row,
    /// and nothing else ever deleted one. Only expired rows go: a rotated or revoked token that has
    /// not expired is kept, so replaying a stolen one still meets the theft response above, and
    /// once expired it would be refused anyway. The caller's save removes them.
    /// </summary>
    private async Task PruneExpiredAsync(string userId, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.ExpiresUtc < now)
            .ToListAsync(cancellationToken);
        _db.RefreshTokens.RemoveRange(expired);
    }

    /// <summary>A new URL-safe random token (256 bits of entropy).</summary>
    private static string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}
