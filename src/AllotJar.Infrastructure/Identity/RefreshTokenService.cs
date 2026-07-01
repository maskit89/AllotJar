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

    private readonly ApplicationDbContext _db;

    public RefreshTokenService(ApplicationDbContext db)
    {
        _db = db;
    }

    public async Task<string> IssueAsync(string userId, CancellationToken cancellationToken = default)
    {
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

        // A token that's already been rotated/revoked turning up again means the cookie was stolen
        // and replayed — burn every active token for the user so neither party can continue.
        if (token.RevokedUtc is not null)
        {
            await RevokeAllForUserAsync(token.UserId, cancellationToken);
            return RefreshRotationResult.Failed;
        }

        if (DateTime.UtcNow >= token.ExpiresUtc)
        {
            return RefreshRotationResult.Failed;
        }

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

    public async Task RevokeAsync(string rawToken, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(rawToken))
        {
            return;
        }

        var hash = Hash(rawToken);
        var token = await _db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, cancellationToken);
        if (token is not null && token.RevokedUtc is null)
        {
            token.RevokedUtc = DateTime.UtcNow;
            await _db.SaveChangesAsync(cancellationToken);
        }
    }

    private async Task RevokeAllForUserAsync(string userId, CancellationToken cancellationToken)
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

    /// <summary>A new URL-safe random token (256 bits of entropy).</summary>
    private static string Generate()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}
