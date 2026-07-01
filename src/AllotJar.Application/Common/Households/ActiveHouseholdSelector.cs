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
}
