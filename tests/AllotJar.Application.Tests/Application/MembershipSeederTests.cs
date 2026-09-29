using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The owner-membership backfill that runs on startup: every existing login gains exactly
/// one Owner membership for its own household, it is idempotent, and it never disturbs a
/// login that already has a membership.
/// </summary>
public class MembershipSeederTests
{
    [Fact]
    public async Task Seeds_exactly_one_owner_per_user_and_is_idempotent()
    {
        using var db = NewContext();
        db.Users.Add(new ApplicationUser { Id = "user-1", Email = "alex@x.com", UserName = "alex@x.com", DisplayName = "Alex" });
        db.Users.Add(new ApplicationUser { Id = "user-2", Email = "sam@x.com", UserName = "sam@x.com" });
        await db.SaveChangesAsync();

        await MembershipSeeder.BackfillOwnerMembershipsAsync(db);
        await MembershipSeeder.BackfillOwnerMembershipsAsync(db); // second run must add nothing

        var memberships = await db.HouseholdMemberships.AsNoTracking().ToListAsync();
        memberships.Should().HaveCount(2);
        memberships.Should().OnlyContain(m =>
            m.Role == HouseholdRole.Owner &&
            m.Status == MembershipStatus.Active &&
            m.OwnerId == m.UserId);
    }

    [Fact]
    public async Task Leaves_existing_memberships_untouched()
    {
        using var db = NewContext();
        db.Users.Add(new ApplicationUser { Id = "user-1", Email = "sam@x.com", UserName = "sam@x.com" });
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = "owner-x",
            UserId = "user-1",
            Role = HouseholdRole.Admin,
            Status = MembershipStatus.Active,
            InvitedEmail = "sam@x.com",
        });
        await db.SaveChangesAsync();

        await MembershipSeeder.BackfillOwnerMembershipsAsync(db);

        var memberships = await db.HouseholdMemberships.AsNoTracking().ToListAsync();
        memberships.Should().HaveCount(1);
        memberships[0].Role.Should().Be(HouseholdRole.Admin);
        memberships[0].OwnerId.Should().Be("owner-x");
    }
}
