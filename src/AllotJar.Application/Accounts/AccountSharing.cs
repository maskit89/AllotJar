using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts;

/// <summary>
/// Who holds an account and who may see it (W13, rules 30–34, P52–P59). The read and write
/// filters that hide a private account from everyone else live in the persistence context; this
/// class decides when an account may become private and fills in what the Accounts page shows.
/// </summary>
public static class AccountSharing
{
    /// <summary>
    /// Validates a holder list (rule 30): each a current person of the household, each once.
    /// Returns them in the order given.
    /// </summary>
    public static async Task<IReadOnlyList<HouseholdMember>> ResolveHoldersAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyList<Guid> holderIds, CancellationToken ct)
    {
        var ids = holderIds.Distinct().ToList();
        if (ids.Count == 0)
        {
            return Array.Empty<HouseholdMember>();
        }

        var members = await db.HouseholdMembers
            .Where(m => m.OwnerId == ownerId && ids.Contains(m.Id))
            .ToListAsync(ct);
        var missing = ids.Where(id => members.All(m => m.Id != id)).ToList();
        if (missing.Count > 0)
        {
            throw new NotFoundException($"Person {missing[0]} was not found.");
        }
        var archived = members.FirstOrDefault(m => m.IsArchived);
        if (archived is not null)
        {
            throw Invalid("HolderIds", $"{archived.Name} is archived and can't hold an account. Restore them on the People page first.");
        }
        return ids.Select(id => members.First(m => m.Id == id)).ToList();
    }

    /// <summary>
    /// Refuses to make <paramref name="account"/> private unless it may be (rules 31/33, P54/P55):
    /// a personal account held by the caller's own person, used by no jar now or in its history.
    /// </summary>
    public static async Task EnsureCanBePrivateAsync(
        IApplicationDbContext db, ICurrentUser currentUser, Account account, IReadOnlyList<HouseholdMember> holders,
        string field, CancellationToken ct)
    {
        if (holders.Count != 1)
        {
            throw Invalid(field, holders.Count == 0
                ? "Only a personal account can be private. Choose who holds it first: an account the household holds is visible to everyone in it."
                : "A joint account can't be private: everyone in the household sees it (rule 33).");
        }
        if (currentUser.UserId is null || currentUser.MemberId != holders[0].Id)
        {
            throw Invalid(field, $"Only {holders[0].Name}'s own login can make their account private.");
        }
        if (await BlockedReasonAsync(db, account, ct) is string reason)
        {
            throw Invalid(field, reason);
        }
    }

    /// <summary>
    /// Why the account can't be private whoever holds it (P55): every jar is part of the household's
    /// budget, so the account behind one — now or in its history — stays visible. Null when nothing blocks it.
    /// </summary>
    public static async Task<string?> BlockedReasonAsync(IApplicationDbContext db, Account account, CancellationToken ct)
    {
        var jar = await db.Jars
            .Where(j => j.FundingAccountId == account.Id)
            .OrderBy(j => j.Name)
            .Select(j => j.Name)
            .FirstOrDefaultAsync(ct);
        if (jar is not null)
        {
            return $"'{account.Name}' holds the jar '{jar}'. Jars are part of the household budget, so the account behind one stays visible to everyone (rule 33).";
        }
        if (await db.JarAllocations.AnyAsync(a => a.AccountId == account.Id, ct))
        {
            return $"'{account.Name}' has held jar money before, and that history is part of the household budget, so the account stays visible to everyone (rule 33).";
        }
        return null;
    }

    /// <summary>Makes the account private to the caller's login, or shared with the household (null).</summary>
    public static async Task SetPrivateAsync(
        IApplicationDbContext db, Account account, string? privateToUserId, CancellationToken ct)
    {
        var existing = await db.AccountPrivacies.FirstOrDefaultAsync(p => p.AccountId == account.Id, ct);
        if (privateToUserId is null)
        {
            if (existing is not null)
            {
                db.AccountPrivacies.Remove(existing);
            }
            return;
        }
        if (existing is null)
        {
            db.AccountPrivacies.Add(new AccountPrivacy { AccountId = account.Id, UserId = privateToUserId });
        }
    }

    /// <summary>
    /// Rule 32 / P54: when someone else makes <paramref name="memberId"/> the only holder of an
    /// account, that person's login (if any) is asked to review its sharing. Nothing about the
    /// account's visibility changes until it does.
    /// </summary>
    public static async Task FlagReviewForHolderAsync(
        IApplicationDbContext db, ICurrentUser currentUser, string ownerId, Guid memberId, CancellationToken ct)
    {
        if (memberId == currentUser.MemberId)
        {
            return;
        }
        var login = await db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.OwnerId == ownerId
                                      && m.MemberId == memberId
                                      && m.UserId != null
                                      && m.Status == MembershipStatus.Active, ct);
        if (login is not null)
        {
            login.SharingReviewPending = true;
        }
    }

    /// <summary>Fills in the holders and the caller's sharing controls on each account's DTO.</summary>
    public static async Task DecorateAsync(
        IApplicationDbContext db, ICurrentUser currentUser, IReadOnlyList<(Account Account, AccountDto Dto)> rows,
        CancellationToken ct)
    {
        if (rows.Count == 0)
        {
            return;
        }
        var ids = rows.Select(r => r.Account.Id).ToList();

        var holders = (await db.AccountHolders
                .Where(h => ids.Contains(h.AccountId))
                .Select(h => new { h.AccountId, h.MemberId, h.Member!.Name, h.Member.DisplayOrder })
                .ToListAsync(ct))
            .GroupBy(h => h.AccountId)
            .ToDictionary(
                g => g.Key,
                g => g.OrderBy(h => h.DisplayOrder).ThenBy(h => h.Name)
                    .Select(h => new AccountHolderDto { MemberId = h.MemberId, Name = h.Name })
                    .ToList());
        var privateIds = (await db.AccountPrivacies
                .Where(p => ids.Contains(p.AccountId))
                .Select(p => p.AccountId)
                .ToListAsync(ct))
            .ToHashSet();

        foreach (var (account, dto) in rows)
        {
            dto.Holders = holders.TryGetValue(account.Id, out var list) ? list : new List<AccountHolderDto>();
            // A private account read here is always private to the caller (the filter hides the
            // rest), and its login may always share it again, even after a re-link (P59).
            dto.IsPrivate = privateIds.Contains(account.Id);
            dto.CanChangeSharing = dto.IsPrivate
                                   || (currentUser.UserId is not null
                                       && currentUser.MemberId is Guid me
                                       && dto.Holders.Count == 1
                                       && dto.Holders[0].MemberId == me);
            dto.SharingBlockedReason = dto.CanChangeSharing && !dto.IsPrivate
                ? await BlockedReasonAsync(db, account, ct)
                : null;
        }
    }

    private static ValidationException Invalid(string field, string message) =>
        new(new Dictionary<string, string[]> { [field] = new[] { message } });
}
