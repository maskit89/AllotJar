using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts;

/// <summary>
/// P53/P56: an account private to another login is not there for the viewer, and "the others never
/// receive a private account's id". A read that holds a soft pointer to an account (a person's
/// savings account, the allocation source) asks here which ids to withhold, and says "private"
/// instead. Mirrors the account query filter: with no viewer nothing is hidden.
/// </summary>
public static class HiddenAccounts
{
    public static async Task<HashSet<Guid>> AmongAsync(
        IApplicationDbContext db, string? viewerId, IEnumerable<Guid?> ids, CancellationToken ct)
    {
        var candidates = ids.OfType<Guid>().Distinct().ToList();
        if (viewerId is null || candidates.Count == 0)
        {
            return new HashSet<Guid>();
        }
        return (await db.AccountPrivacies
                .Where(p => candidates.Contains(p.AccountId) && p.UserId != viewerId)
                .Select(p => p.AccountId)
                .ToListAsync(ct))
            .ToHashSet();
    }

    public static async Task<bool> IsHiddenAsync(IApplicationDbContext db, string? viewerId, Guid? id, CancellationToken ct) =>
        id is Guid accountId && viewerId is not null
        && await db.AccountPrivacies.AnyAsync(p => p.AccountId == accountId && p.UserId != viewerId, ct);
}
