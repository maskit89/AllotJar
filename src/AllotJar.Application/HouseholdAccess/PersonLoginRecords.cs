using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess;

/// <summary>
/// Whose login a budget person is (S-P3-8, D5: only the person's own login may make their account
/// private, P54). The owner decides which login is linked to which person, so every login ever
/// linked to a person is remembered (<see cref="PersonLogin"/>), not only the current or the first
/// one. While any other remembered login is still in the household and hasn't released its link,
/// no login may make the person's accounts private: re-linking people can't hide a member's account
/// from them, whichever order the links were made in.
/// <para>
/// Links made before this record existed are recorded lazily: the current link always counts (it
/// is read from the membership itself) and is written down when it is first changed or removed.
/// </para>
/// </summary>
public static class PersonLoginRecords
{
    /// <summary>
    /// Records that <paramref name="userId"/> is now linked to <paramref name="memberId"/>. A link the
    /// login had released counts again once the owner links it back.
    /// </summary>
    public static Task RecordLinkAsync(IApplicationDbContext db, Guid? memberId, string? userId, CancellationToken ct) =>
        RecordAsync(db, memberId, userId, linkedNow: true, ct);

    /// <summary>
    /// Records that <paramref name="userId"/> stops being <paramref name="memberId"/>'s login (unlinked,
    /// re-linked elsewhere, left or removed). The link stays on record: only the login itself can release it.
    /// </summary>
    public static Task RecordUnlinkAsync(IApplicationDbContext db, Guid? memberId, string? userId, CancellationToken ct) =>
        RecordAsync(db, memberId, userId, linkedNow: false, ct);

    private static async Task RecordAsync(
        IApplicationDbContext db, Guid? memberId, string? userId, bool linkedNow, CancellationToken ct)
    {
        if (memberId is not Guid id || string.IsNullOrEmpty(userId))
        {
            return;
        }
        var row = await db.PersonLogins.FindAsync(new object[] { id, userId }, ct);
        if (row is null)
        {
            db.PersonLogins.Add(new PersonLogin { HouseholdMemberId = id, UserId = userId, LinkedUtc = DateTime.UtcNow });
        }
        else if (linkedNow && row.ReleasedUtc is not null)
        {
            row.ReleasedUtc = null;
            row.LinkedUtc = DateTime.UtcNow;
        }
    }

    /// <summary>
    /// Whether a login other than <paramref name="userId"/> that was ever linked to <paramref name="person"/>
    /// (or is linked now), hasn't released that link and is still an active member of the household,
    /// so <paramref name="userId"/> may not make the person's accounts private.
    /// </summary>
    public static async Task<bool> BelongsToAnotherLoginAsync(
        IApplicationDbContext db, HouseholdMember person, string? userId, CancellationToken ct)
    {
        var ownerId = person.OwnerId;
        var activeLogins = db.HouseholdMemberships
            .Where(m => m.OwnerId == ownerId && m.Status == MembershipStatus.Active && m.UserId != null);
        if (await activeLogins.AnyAsync(m => m.MemberId == person.Id && m.UserId != userId, ct))
        {
            return true;
        }
        return await db.PersonLogins.AnyAsync(
            p => p.HouseholdMemberId == person.Id
                 && p.ReleasedUtc == null
                 && p.UserId != userId
                 && activeLogins.Any(m => m.UserId == p.UserId),
            ct);
    }

    /// <summary>
    /// The people of <paramref name="ownerId"/>'s household whose link <paramref name="userId"/> may
    /// release ("This isn't me"): ones it was linked to before, hasn't released, and isn't linked to now.
    /// </summary>
    public static async Task<IReadOnlySet<Guid>> ReleasableAsync(
        IApplicationDbContext db, string ownerId, string? userId, CancellationToken ct)
    {
        if (userId is null)
        {
            return new HashSet<Guid>();
        }
        var current = await db.HouseholdMemberships
            .Where(m => m.OwnerId == ownerId && m.UserId == userId && m.MemberId != null)
            .Select(m => m.MemberId)
            .FirstOrDefaultAsync(ct);
        var ids = await db.PersonLogins
            .Where(p => p.UserId == userId
                        && p.ReleasedUtc == null
                        && db.HouseholdMembers.Any(m => m.Id == p.HouseholdMemberId && m.OwnerId == ownerId))
            .Select(p => p.HouseholdMemberId)
            .ToListAsync(ct);
        return ids.Where(id => id != current).ToHashSet();
    }
}
