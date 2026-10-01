using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess;

/// <summary>
/// Whose login a budget person is (S-P3-8). Only the person's own login may make their account
/// private (P54), and the owner decides which login is linked to which person, so a person
/// remembers the login it had when that login is unlinked, re-linked elsewhere or leaves. While
/// that login is still in the household, no other login linked to the person may make the
/// person's accounts private: re-linking people can't hide a member's account from them.
/// </summary>
public static class PersonLogin
{
    /// <summary>
    /// Records that <paramref name="userId"/> stops being <paramref name="memberId"/>'s login. The
    /// first such login is kept while it is still in the household, so unlinking a later one (the
    /// owner's own, say) never replaces it.
    /// </summary>
    public static async Task RecordUnlinkAsync(
        IApplicationDbContext db, string ownerId, Guid? memberId, string? userId, CancellationToken ct)
    {
        if (memberId is not Guid id || userId is null)
        {
            return;
        }
        var person = await db.HouseholdMembers.FirstOrDefaultAsync(m => m.Id == id && m.OwnerId == ownerId, ct);
        if (person is null || person.FormerLoginUserId == userId)
        {
            return;
        }
        if (person.FormerLoginUserId is string earlier && await InHouseholdAsync(db, ownerId, earlier, ct))
        {
            return;
        }
        person.FormerLoginUserId = userId;
    }

    /// <summary>
    /// Whether <paramref name="person"/> belongs to a login other than <paramref name="userId"/> that
    /// is still in the household, so <paramref name="userId"/> may not make the person's accounts private.
    /// </summary>
    public static async Task<bool> BelongsToAnotherLoginAsync(
        IApplicationDbContext db, HouseholdMember person, string? userId, CancellationToken ct) =>
        person.FormerLoginUserId is string former
        && former != userId
        && await InHouseholdAsync(db, person.OwnerId, former, ct);

    private static Task<bool> InHouseholdAsync(IApplicationDbContext db, string ownerId, string userId, CancellationToken ct) =>
        db.HouseholdMemberships.AnyAsync(
            m => m.OwnerId == ownerId && m.UserId == userId && m.Status == MembershipStatus.Active, ct);
}
