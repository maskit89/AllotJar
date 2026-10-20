using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Infrastructure.Retention;

/// <summary>
/// Deletes sign-in and invitation records once they are of no further use (compliance fix 9), so
/// the privacy policy's retention periods hold even for a login that never comes back:
/// <list type="bullet">
/// <item>Refresh tokens past their expiry. A rotated or revoked token that has not expired stays,
/// so replaying a stolen one still meets the theft response; once expired it is refused anyway.
/// <c>RefreshTokenService</c> also prunes a login's own expired rows when it signs in or refreshes,
/// but a login that never returns would otherwise keep them for good.</item>
/// <item>Invitations nobody accepted, <see cref="InviteGraceDays"/> after the link expired. Until
/// then the owner still sees the invitation and can send it again.</item>
/// </list>
/// </summary>
public class ExpiredRecordsPurge
{
    /// <summary>How long an unaccepted invitation, with the email it was sent to, is kept after its
    /// link expires. The privacy policy states this period.</summary>
    public const int InviteGraceDays = 30;

    private readonly ApplicationDbContext _db;

    public ExpiredRecordsPurge(ApplicationDbContext db)
    {
        _db = db;
    }

    public async Task<PurgeResult> RunAsync(DateTime nowUtc, CancellationToken cancellationToken = default)
    {
        var tokens = _db.RefreshTokens.Where(t => t.ExpiresUtc < nowUtc);

        var inviteCutoff = nowUtc.AddDays(-InviteGraceDays);
        var invites = _db.HouseholdMemberships.Where(m =>
            m.Status == MembershipStatus.Invited
            && m.UserId == null
            && m.InviteExpiresUtc != null
            && m.InviteExpiresUtc < inviteCutoff);

        if (_db.Database.IsRelational())
        {
            // Set-based: a refresh pruning the same rows at the same moment is no conflict.
            var tokenCount = await tokens.ExecuteDeleteAsync(cancellationToken);
            var inviteCount = await invites.ExecuteDeleteAsync(cancellationToken);
            return new PurgeResult(tokenCount, inviteCount);
        }

        var expiredTokens = await tokens.ToListAsync(cancellationToken);
        var expiredInvites = await invites.ToListAsync(cancellationToken);
        _db.RefreshTokens.RemoveRange(expiredTokens);
        _db.HouseholdMemberships.RemoveRange(expiredInvites);
        await _db.SaveChangesAsync(cancellationToken);
        return new PurgeResult(expiredTokens.Count, expiredInvites.Count);
    }
}

/// <summary>How many rows one purge deleted.</summary>
public record PurgeResult(int RefreshTokens, int Invitations);
