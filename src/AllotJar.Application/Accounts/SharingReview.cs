using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Accounts;

/// <summary>The sharing review a login owes for its personal accounts (rule 32, P58).</summary>
public static class SharingReview
{
    /// <summary>Every account the caller's own person holds alone, holders loaded.</summary>
    public static async Task<List<Account>> PersonalAccountsAsync(
        IApplicationDbContext db, ICurrentUser currentUser, string ownerId, CancellationToken ct)
    {
        if (currentUser.MemberId is not Guid me)
        {
            return new List<Account>();
        }
        return await db.Accounts
            .Include(a => a.Holders)
                .ThenInclude(h => h.Member)
            .Where(a => a.OwnerId == ownerId
                        && a.Holders.Count == 1
                        && a.Holders.Any(h => h.MemberId == me))
            .OrderBy(a => a.DisplayOrder)
                .ThenBy(a => a.Name)
            .ToListAsync(ct);
    }

    /// <summary>True when the caller owes a review and holds at least one personal account (cheap: no balances).</summary>
    public static async Task<bool> IsDueAsync(IApplicationDbContext db, ICurrentUser currentUser, CancellationToken ct)
    {
        if (currentUser.OwnerId is not string ownerId || currentUser.UserId is not string userId || currentUser.MemberId is not Guid me)
        {
            return false;
        }
        return await db.HouseholdMemberships.AnyAsync(m => m.OwnerId == ownerId && m.UserId == userId && m.SharingReviewPending, ct)
               && await db.Accounts.AnyAsync(a => a.OwnerId == ownerId
                                                  && a.Holders.Count == 1
                                                  && a.Holders.Any(h => h.MemberId == me), ct);
    }

    public static async Task<SharingReviewDto> ReadAsync(IApplicationDbContext db, ICurrentUser currentUser, CancellationToken ct)
    {
        var ownerId = currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var accounts = await PersonalAccountsAsync(db, currentUser, ownerId, ct);
        var pending = currentUser.UserId is string userId
                      && await db.HouseholdMemberships.AnyAsync(
                          m => m.OwnerId == ownerId && m.UserId == userId && m.SharingReviewPending, ct);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(db, ownerId, accounts, asOf, ct);
        var rows = accounts.Select(a => (a, a.ToDto(views[a.Id]))).ToList();
        await AccountSharing.DecorateAsync(db, currentUser, rows, ct);

        return new SharingReviewDto
        {
            Pending = pending && accounts.Count > 0,
            Accounts = rows.Select(r => r.Item2).ToList(),
        };
    }
}
