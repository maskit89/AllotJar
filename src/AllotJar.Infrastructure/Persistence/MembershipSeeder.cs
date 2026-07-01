using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Backfills an <see cref="HouseholdRole.Owner"/> membership for every existing login that
/// doesn't have one. Runs once on startup after migrations. Idempotent: a login that already
/// has a membership is skipped, so this is safe to run on every boot. Existing budget data is
/// untouched — it already carries each owner's id, which is exactly the household key.
/// </summary>
public static class MembershipSeeder
{
    public static async Task BackfillOwnerMembershipsAsync(
        ApplicationDbContext db, CancellationToken ct = default)
    {
        var claimedUserIds = await db.HouseholdMemberships
            .Where(m => m.UserId != null)
            .Select(m => m.UserId!)
            .ToListAsync(ct);
        var claimed = claimedUserIds.ToHashSet();

        var users = await db.Users
            .Select(u => new { u.Id, u.Email, u.DisplayName })
            .ToListAsync(ct);

        var toAdd = users.Where(u => !claimed.Contains(u.Id)).ToList();
        if (toAdd.Count == 0)
        {
            return;
        }

        foreach (var u in toAdd)
        {
            db.HouseholdMemberships.Add(new HouseholdMembership
            {
                OwnerId = u.Id,
                UserId = u.Id,
                Role = HouseholdRole.Owner,
                Status = MembershipStatus.Active,
                InvitedEmail = u.Email ?? string.Empty,
                DisplayName = u.DisplayName,
                CreatedUtc = DateTime.UtcNow,
            });
        }

        await db.SaveChangesAsync(ct);
    }
}
