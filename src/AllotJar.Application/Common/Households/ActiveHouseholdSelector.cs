using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Common.Households;

/// <summary>A login's membership in one household, reduced to what household resolution needs.</summary>
public readonly record struct HouseholdMembershipRef(string OwnerId, HouseholdRole Role, Guid? MemberId);

/// <summary>
/// Decides which household a login is acting in for the current request, given all the households it
/// can access. Pure and order-independent so it can be unit-tested away from the request pipeline.
/// </summary>
public static class ActiveHouseholdSelector
{
    /// <summary>
    /// Returns the login's selected household (<paramref name="activeOwnerId"/>) if it still has access,
    /// otherwise their own household (<c>OwnerId == userId</c>), otherwise the first available — or
    /// <c>null</c> when they have no memberships at all.
    /// </summary>
    public static HouseholdMembershipRef? Pick(
        IReadOnlyList<HouseholdMembershipRef> memberships, string? activeOwnerId, string userId)
    {
        if (memberships.Count == 0)
        {
            return null;
        }

        foreach (var m in memberships)
        {
            if (m.OwnerId == activeOwnerId)
            {
                return m;
            }
        }

        foreach (var m in memberships)
        {
            if (m.OwnerId == userId)
            {
                return m;
            }
        }

        return memberships[0];
    }

    /// <summary>
    /// The login's role in the household it acts in (S-P3-5), picked as each request picks it: the
    /// chosen household while the login still belongs to it, else its own, else the first. Owner
    /// when it belongs to none yet (a new registrant owns its own household).
    /// </summary>
    public static async Task<HouseholdRole> ActiveRoleAsync(
        IApplicationDbContext db, string userId, string? activeOwnerId, CancellationToken cancellationToken)
    {
        var memberships = await db.HouseholdMemberships
            .Where(m => m.UserId == userId && m.Status == MembershipStatus.Active)
            .Select(m => new HouseholdMembershipRef(m.OwnerId, m.Role, m.MemberId))
            .ToListAsync(cancellationToken);
        return Pick(memberships, activeOwnerId, userId)?.Role ?? HouseholdRole.Owner;
    }
}
