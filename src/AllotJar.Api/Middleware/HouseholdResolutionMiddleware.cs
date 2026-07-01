using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using AllotJar.Api.Services;
using AllotJar.Application.Common.Households;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Api.Middleware;

/// <summary>
/// After authentication, resolves which household the caller is currently acting in and stashes the
/// household id + role into the per-request <see cref="HouseholdContext"/>. A login may belong to
/// several households; the active one is the login's <c>ActiveOwnerId</c> (their own household when
/// unset). Resolving server-side every request — rather than baking the role into the JWT — means a
/// revoked or downgraded membership, or a household switch, takes effect immediately.
/// </summary>
public class HouseholdResolutionMiddleware
{
    private readonly RequestDelegate _next;

    public HouseholdResolutionMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, ApplicationDbContext db, HouseholdContext household)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!string.IsNullOrEmpty(userId))
        {
            var rows = await db.HouseholdMemberships
                .AsNoTracking()
                .Where(m => m.UserId == userId && m.Status == MembershipStatus.Active)
                .Select(m => new { m.OwnerId, m.Role, m.MemberId })
                .ToListAsync(context.RequestAborted);

            if (rows.Count > 0)
            {
                var activeOwnerId = await db.Users
                    .AsNoTracking()
                    .Where(u => u.Id == userId)
                    .Select(u => u.ActiveOwnerId)
                    .FirstOrDefaultAsync(context.RequestAborted);

                var memberships = rows
                    .Select(r => new HouseholdMembershipRef(r.OwnerId, r.Role, r.MemberId))
                    .ToList();
                var chosen = ActiveHouseholdSelector.Pick(memberships, activeOwnerId, userId)!.Value;

                household.OwnerId = chosen.OwnerId;
                household.Role = chosen.Role;
                household.MemberId = chosen.MemberId;
            }
            else
            {
                // No membership yet (e.g. a brand-new registrant before the owner row is
                // seeded, or pre-existing data): the caller owns their own household.
                household.OwnerId = userId;
                household.Role = HouseholdRole.Owner;
            }

            household.Resolved = true;
        }

        await _next(context);
    }
}
