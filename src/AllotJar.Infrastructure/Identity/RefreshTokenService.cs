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
    /// The longest one sign-in lasts, however often it is used: every rotation renews the token for
    /// <see cref="LifetimeDays"/>, but never past this many days after the sign-in began.
    /// </summary>
    public const int MaxSessionDays = 90;

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

    public async Task<string> IssueAsync(string userId, string? device = null, CancellationToken cancellationToken = default)
    {
        await PruneExpiredAsync(userId, cancellationToken);
        var raw = Generate();
        var now = DateTime.UtcNow;
        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = userId,
            TokenHash = Hash(raw),
            CreatedUtc = now,
            ExpiresUtc = ExpiryFor(now, now),
            SessionId = Guid.NewGuid(),
            SessionStartedUtc = now,
            Device = Trim(device),
        });
        await _db.SaveChangesAsync(cancellationToken);
        return raw;
    }

    public async Task<RefreshRotationResult> RotateAsync(string rawToken, string? device = null, CancellationToken cancellationToken = default)
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

        // The session's maximum age is checked as well as the token's own expiry: a token issued
        // before the cap existed may expire later than its session allows.
        var now = DateTime.UtcNow;
        if (now >= token.ExpiresUtc || now >= token.SessionStartedUtc.AddDays(MaxSessionDays))
        {
            return RefreshRotationResult.Failed;
        }

        await PruneExpiredAsync(token.UserId, cancellationToken);
        var newRaw = Generate();
        var expires = ExpiryFor(token.SessionStartedUtc, now);
        token.RevokedUtc = now;
        token.ReplacedByTokenHash = Hash(newRaw);
        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = token.UserId,
            TokenHash = token.ReplacedByTokenHash,
            CreatedUtc = now,
            ExpiresUtc = expires,
            SessionId = token.SessionId,
            SessionStartedUtc = token.SessionStartedUtc,
            // A sign-in from before devices were recorded learns its device at its next refresh.
            Device = token.Device ?? Trim(device),
        });
        await _db.SaveChangesAsync(cancellationToken);
        return RefreshRotationResult.Success(token.UserId, newRaw, expires);
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

    public async Task<IReadOnlyList<ActiveSession>> ListActiveAsync(string userId, string? currentRawToken, CancellationToken cancellationToken = default)
    {
        var now = DateTime.UtcNow;
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.RevokedUtc == null && t.ExpiresUtc > now)
            .ToListAsync(cancellationToken);
        var currentHash = string.IsNullOrEmpty(currentRawToken) ? null : Hash(currentRawToken);
        var currentSession = currentHash is null
            ? (Guid?)null
            : await _db.RefreshTokens
                .Where(t => t.UserId == userId && t.TokenHash == currentHash)
                .Select(t => (Guid?)t.SessionId)
                .FirstOrDefaultAsync(cancellationToken);

        // One row per sign-in: its newest token says when the device last refreshed.
        return active
            .GroupBy(t => t.SessionId)
            .Select(g => g.OrderByDescending(t => t.CreatedUtc).First())
            .Select(t => new ActiveSession(t.SessionId, t.Device, t.SessionStartedUtc, t.CreatedUtc, t.SessionId == currentSession))
            .OrderByDescending(s => s.Current)
            .ThenByDescending(s => s.LastActiveUtc)
            .ToList();
    }

    public async Task<bool> RevokeSessionAsync(string userId, Guid sessionId, CancellationToken cancellationToken = default)
    {
        var active = await _db.RefreshTokens
            .Where(t => t.UserId == userId && t.SessionId == sessionId && t.RevokedUtc == null)
            .ToListAsync(cancellationToken);
        if (active.Count == 0)
        {
            return false;
        }
        foreach (var t in active)
        {
            t.RevokedUtc = DateTime.UtcNow;
        }
        await _db.SaveChangesAsync(cancellationToken);
        return true;
    }

    /// <summary>A token minted now for a session that began at <paramref name="sessionStartedUtc"/>:
    /// the usual lifetime, cut short at the session's maximum age.</summary>
    private static DateTime ExpiryFor(DateTime sessionStartedUtc, DateTime now)
    {
        var renewed = now.AddDays(LifetimeDays);
        var cap = sessionStartedUtc.AddDays(MaxSessionDays);
        return renewed < cap ? renewed : cap;
    }

    private static string? Trim(string? device) =>
        string.IsNullOrWhiteSpace(device) ? null : device.Length > 100 ? device[..100] : device;

    /// <summary>
    /// Removes the login's tokens past their expiry (S-P3-1): every issue and rotation adds a row,
    /// and nothing else ever deleted one. Only expired rows go: a rotated or revoked token that has
    /// not expired is kept, so replaying a stolen one still meets the theft response above, and
    /// once expired it would be refused anyway. The caller's save removes them.
    /// </summary>
    private async Task PruneExpiredAsync(string userId, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = _db.RefreshTokens.Where(t => t.UserId == userId && t.ExpiresUtc < now);
        if (_db.Database.IsRelational())
        {
            // Set-based: a concurrent refresh that already removed the same rows is no conflict.
            await expired.ExecuteDeleteAsync(cancellationToken);
            return;
        }
        _db.RefreshTokens.RemoveRange(await expired.ToListAsync(cancellationToken));
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
