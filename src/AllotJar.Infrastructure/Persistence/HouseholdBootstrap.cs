using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Materializes a login's OWN household — an Owner membership and the owner as member #1 —
/// idempotently. This is what a brand-new registration gets, and it is also how a member who only
/// ever joined someone else's household later starts a budget of their own. Nothing is seeded
/// (rule 81): the household starts empty and the Budget page's first-run checklist takes over.
/// Every step is guarded, so it is safe to call when some or all of the pieces already exist.
/// </summary>
public static class HouseholdBootstrap
{
    /// <summary>
    /// Ensures <paramref name="user"/> owns a household: adds their Owner membership if missing
    /// and creates the owner member. Returns true when an Owner membership was created by this
    /// call (false if it already existed).
    /// </summary>
    public static async Task<bool> EnsureOwnHouseholdAsync(
        ApplicationDbContext db, ApplicationUser user, DateTime nowUtc,
        CancellationToken ct = default)
    {
        var hasOwnMembership = await db.HouseholdMemberships
            .AnyAsync(m => m.OwnerId == user.Id && m.UserId == user.Id, ct);

        var created = false;
        if (!hasOwnMembership)
        {
            db.HouseholdMemberships.Add(new HouseholdMembership
            {
                OwnerId = user.Id,
                UserId = user.Id,
                Role = HouseholdRole.Owner,
                Status = MembershipStatus.Active,
                InvitedEmail = user.Email!,
                DisplayName = user.DisplayName,
                CreatedUtc = nowUtc,
            });
            await db.SaveChangesAsync(ct);
            created = true;
        }

        // The owner as member #1, so the household is never "0 members". Idempotent.
        await OwnerMemberSeeder.EnsureOwnerMemberAsync(
            db, user.Id, OwnerMemberSeeder.ResolveOwnerName(user.FirstName, user.DisplayName, user.Email), ct);

        return created;
    }
}
