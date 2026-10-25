using System.Linq.Expressions;
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

        // A token whose sign-in was signed out is refused as it is: the sign-out already ended
        // every token of that sign-in, a stolen branch included, so there is nothing left to burn.
        if (token.SignedOutUtc is not null)
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
        var newHash = Hash(newRaw);
        if (!await ClaimAsync(token, now, newHash, cancellationToken))
        {
            // Something else wrote to the token since it was read. A sign-out (or the purge, at the
            // token's last instant) wins: refused, not a 500. Only a sibling tab's rotation of the
            // same cookie lets this one carry on, with a token of its own, as both tabs did before.
            var current = await _db.RefreshTokens.AsNoTracking()
                .Where(t => t.Id == token.Id)
                .Select(t => new { t.SignedOutUtc, t.ReplacedByTokenHash })
                .FirstOrDefaultAsync(cancellationToken);
            if (current is null || current.SignedOutUtc is not null || current.ReplacedByTokenHash is null)
            {
                return RefreshRotationResult.Failed;
            }
        }

        var expires = ExpiryFor(token.SessionStartedUtc, now);
        _db.RefreshTokens.Add(new RefreshToken
        {
            UserId = token.UserId,
            TokenHash = newHash,
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

    public async Task<bool> ConfirmAsync(string newRawToken, CancellationToken cancellationToken = default)
    {
        var hash = Hash(newRawToken);
        var token = await _db.RefreshTokens.AsNoTracking()
            .Where(t => t.TokenHash == hash)
            .Select(t => new { t.UserId, t.SessionId })
            .FirstOrDefaultAsync(cancellationToken);
        if (token is null)
        {
            return false;
        }

        // A sign-out marks its sign-in's tokens, commits, and only then revokes. So once this
        // rotation is committed, either this read sees the mark, or the rotation committed before
        // the mark did, and the sign-out's revoke (which runs after its mark) catches the new token.
        // On a mark, end the sign-in again here: its revoke may have run before this token existed.
        var signedOut = await _db.RefreshTokens.AsNoTracking().AnyAsync(
            t => t.UserId == token.UserId && t.SessionId == token.SessionId && t.SignedOutUtc != null,
            cancellationToken);
        if (!signedOut)
        {
            return true;
        }

        await EndAsync(t => t.UserId == token.UserId && t.SessionId == token.SessionId, cancellationToken);
        return false;
    }

    public async Task<string?> RevokeAsync(string rawToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(rawToken))
        {
            return null;
        }

        var hash = Hash(rawToken);
        var token = await _db.RefreshTokens.AsNoTracking()
            .Where(t => t.TokenHash == hash)
            .Select(t => new { t.UserId, t.SessionId })
            .FirstOrDefaultAsync(cancellationToken);
        if (token is null)
        {
            return null;
        }

        // The whole sign-in ends, not just the token presented: a refresh that rotated it a moment
        // earlier has already minted the next one.
        await EndAsync(t => t.UserId == token.UserId && t.SessionId == token.SessionId, cancellationToken);
        return token.UserId;
    }

    public async Task RevokeAllForUserAsync(string userId, CancellationToken cancellationToken = default)
    {
        await EndAsync(t => t.UserId == userId, cancellationToken);
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
        return await EndAsync(t => t.UserId == userId && t.SessionId == sessionId, cancellationToken) > 0;
    }

    /// <summary>
    /// Signs out the tokens in <paramref name="scope"/>: marks them signed out, then revokes those
    /// still active. Returns how many were still active. On SQL each step is one set-based statement
    /// committed on its own, the mark first (see <see cref="ConfirmAsync"/>): a refresh that slips a
    /// new token in between is caught by the revoke or by its own check, and a row the purge deleted
    /// meanwhile is no conflict (a tracked update of it affected 0 rows and failed with a 500).
    /// </summary>
    private async Task<int> EndAsync(Expression<Func<RefreshToken, bool>> scope, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        if (_db.Database.IsRelational())
        {
            await _db.RefreshTokens.Where(scope).Where(t => t.SignedOutUtc == null)
                .ExecuteUpdateAsync(u => u.SetProperty(t => t.SignedOutUtc, now), cancellationToken);
            return await _db.RefreshTokens.Where(scope).Where(t => t.RevokedUtc == null)
                .ExecuteUpdateAsync(u => u.SetProperty(t => t.RevokedUtc, now), cancellationToken);
        }

        var tokens = await _db.RefreshTokens.Where(scope).ToListAsync(cancellationToken);
        var active = 0;
        foreach (var t in tokens)
        {
            t.SignedOutUtc ??= now;
            if (t.RevokedUtc is null)
            {
                t.RevokedUtc = now;
                active++;
            }
        }
        await _db.SaveChangesAsync(cancellationToken);
        return active;
    }

    /// <summary>
    /// Marks <paramref name="token"/> rotated, only if nothing else has revoked, signed out or
    /// deleted it since it was read. On SQL that is one conditional UPDATE: two writers can no longer
    /// both read it active and the later save undo the earlier (a refresh outliving a sign-out).
    /// </summary>
    private async Task<bool> ClaimAsync(RefreshToken token, DateTime now, string newHash, CancellationToken cancellationToken)
    {
        if (_db.Database.IsRelational())
        {
            return await _db.RefreshTokens
                .Where(t => t.Id == token.Id && t.RevokedUtc == null && t.SignedOutUtc == null)
                .ExecuteUpdateAsync(u => u
                    .SetProperty(t => t.RevokedUtc, now)
                    .SetProperty(t => t.ReplacedByTokenHash, newHash), cancellationToken) == 1;
        }

        token.RevokedUtc = now;
        token.ReplacedByTokenHash = newHash;
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
