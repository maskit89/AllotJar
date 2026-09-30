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
        IApplicationDbContext db, string ownerId, CancellationToken cancellationToken)
    {
        var ids = await UnreachableIdsAsync(db, ownerId, cancellationToken);
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
    /// the household. The owner's own private accounts are reachable by the owner.
    /// </summary>
    public static async Task<HashSet<Guid>> UnreachableIdsAsync(
        IApplicationDbContext db, string ownerId, CancellationToken cancellationToken)
    {
        var rows = await db.AccountPrivacies.AsNoTracking()
            .Where(p => p.UserId != ownerId
                        && db.Accounts.IgnoreQueryFilters().Any(a => a.Id == p.AccountId && a.OwnerId == ownerId)
                        && !db.HouseholdMemberships.Any(m => m.OwnerId == ownerId && m.UserId == p.UserId))
            .Select(p => p.AccountId)
            .ToListAsync(cancellationToken);
        return rows.ToHashSet();
    }
}
