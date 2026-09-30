using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts;

/// <summary>
/// The household's accounts nobody can reach (P59): private to a login that has no membership
/// in the household any more, so its holder can't see or share it and neither can anyone else.
/// Read past the privacy filter, since the caller by definition can't see them.
/// </summary>
public static class UnreachableAccounts
{
    public static async Task<List<UnreachableAccountDto>> ListAsync(
        IApplicationDbContext db, IIdentityService identity, string ownerId, CancellationToken cancellationToken)
    {
        var ids = await UnreachableIdsAsync(db, identity, ownerId, cancellationToken);
        if (ids.Count == 0)
        {
            return new List<UnreachableAccountDto>();
        }
        var accounts = await db.Accounts.IgnoreQueryFilters().AsNoTracking()
            .Where(a => ids.Contains(a.Id))
            .OrderBy(a => a.DisplayOrder).ThenBy(a => a.Name)
            .Select(a => new
            {
                a.Id, a.Name, Currency = a.Currency.Value,
                HolderName = a.Holders.Select(h => h.Member!.Name).FirstOrDefault(),
                Since = db.AccountPrivacies.Where(p => p.AccountId == a.Id).Select(p => p.SinceUtc).FirstOrDefault(),
                EntryCount = db.Transactions.IgnoreQueryFilters()
                    .Count(t => t.AccountId == a.Id || (t.Type == TransactionType.Transfer && t.TransferAccountId == a.Id)
                                || (t.FeeForTransfer != null && t.FeeForTransfer.TransferAccountId == a.Id)),
            })
            .ToListAsync(cancellationToken);
        return accounts.Select(a => new UnreachableAccountDto
        {
            Id = a.Id, Name = a.Name, Currency = a.Currency, HolderName = a.HolderName,
            PrivateSinceUtc = a.Since, EntryCount = a.EntryCount,
        }).ToList();
    }

    /// <summary>
    /// The ids of <paramref name="ownerId"/>'s accounts private to a login with no membership in
    /// the household. The owner's own private accounts are reachable by the owner, and so is an
    /// account whose login has an open invitation back into the household (the same email; once
    /// accepted, the login sees the account again by P59).
    /// </summary>
    public static async Task<HashSet<Guid>> UnreachableIdsAsync(
        IApplicationDbContext db, IIdentityService identity, string ownerId, CancellationToken cancellationToken)
    {
        var rows = await db.AccountPrivacies.AsNoTracking()
            .Where(p => p.UserId != ownerId
                        && db.Accounts.IgnoreQueryFilters().Any(a => a.Id == p.AccountId && a.OwnerId == ownerId)
                        && !db.HouseholdMemberships.Any(m => m.OwnerId == ownerId && m.UserId == p.UserId))
            .Select(p => new { p.AccountId, p.UserId })
            .ToListAsync(cancellationToken);
        if (rows.Count == 0)
        {
            return new HashSet<Guid>();
        }
        var invited = (await db.HouseholdMemberships.AsNoTracking()
                .Where(m => m.OwnerId == ownerId && m.Status == MembershipStatus.Invited && m.UserId == null)
                .Select(m => m.InvitedEmail)
                .ToListAsync(cancellationToken))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var onTheirWayBack = new HashSet<string>();
        if (invited.Count > 0)
        {
            foreach (var userId in rows.Select(r => r.UserId).Distinct())
            {
                var login = await identity.FindByIdAsync(userId);
                if (login is not null && invited.Contains(login.Email))
                {
                    onTheirWayBack.Add(userId);
                }
            }
        }
        return rows.Where(r => !onTheirWayBack.Contains(r.UserId)).Select(r => r.AccountId).ToHashSet();
    }
}
