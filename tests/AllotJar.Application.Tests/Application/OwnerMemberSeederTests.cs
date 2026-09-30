using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The owner-member backfill that guarantees a household is never "0 members": every household
/// gains the owner as member #1, named from the owner login, idempotently, and a household that
/// already has members (e.g. a shared one) is left exactly as it was.
/// </summary>
public class OwnerMemberSeederTests
{
    private static HouseholdMembership Owner(string id) => new()
    {
        OwnerId = id,
        UserId = id,
        Role = HouseholdRole.Owner,
        Status = MembershipStatus.Active,
        InvitedEmail = $"{id}@x.com",
    };

    [Fact]
    public async Task Backfills_one_owner_member_named_from_first_name_and_is_idempotent()
    {
        using var db = NewContext();
        db.Users.Add(new ApplicationUser { Id = "user-1", Email = "alex@x.com", UserName = "alex@x.com", FirstName = "Alex", DisplayName = "Alex M" });
        db.HouseholdMemberships.Add(Owner("user-1"));
        await db.SaveChangesAsync();

        await OwnerMemberSeeder.BackfillOwnerMembersAsync(db);
        await OwnerMemberSeeder.BackfillOwnerMembersAsync(db); // second run must add nothing

        var members = await db.HouseholdMembers.AsNoTracking().ToListAsync();
        members.Should().ContainSingle();
        members[0].OwnerId.Should().Be("user-1");
        members[0].Name.Should().Be("Alex"); // first name wins
        members[0].NetMonthlyIncome.Should().Be(0m);
        members[0].DisplayOrder.Should().Be(0);
        members[0].IsArchived.Should().BeFalse();

        // The owner's own membership is linked to that person (the 1:1 person↔login link).
        var ownerMembership = await db.HouseholdMemberships.AsNoTracking().SingleAsync();
        ownerMembership.MemberId.Should().Be(members[0].Id);
    }

    [Fact]
    public async Task EnsureOwnerMember_links_the_owner_membership_to_the_new_person()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner("owner-1"));
        await db.SaveChangesAsync();

        await OwnerMemberSeeder.EnsureOwnerMemberAsync(db, "owner-1", "Sam");

        var member = await db.HouseholdMembers.AsNoTracking().SingleAsync(m => m.OwnerId == "owner-1");
        var membership = await db.HouseholdMemberships.AsNoTracking().SingleAsync(m => m.OwnerId == "owner-1");
        membership.MemberId.Should().Be(member.Id);
    }

    [Fact]
    public async Task Leaves_a_household_that_already_has_members_untouched()
    {
        using var db = NewContext();
        db.Users.Add(new ApplicationUser { Id = "owner-1", Email = "owner@x.com", UserName = "owner@x.com", FirstName = "Owner" });
        db.HouseholdMemberships.Add(Owner("owner-1"));
        db.HouseholdMembers.Add(new HouseholdMember { OwnerId = "owner-1", Name = "Alex", DisplayOrder = 0 });
        db.HouseholdMembers.Add(new HouseholdMember { OwnerId = "owner-1", Name = "Sam", DisplayOrder = 1 });
        await db.SaveChangesAsync();

        await OwnerMemberSeeder.BackfillOwnerMembersAsync(db);

        var members = await db.HouseholdMembers.AsNoTracking().Where(m => m.OwnerId == "owner-1").ToListAsync();
        members.Should().HaveCount(2); // no third member added
        members.Select(m => m.Name).Should().BeEquivalentTo(new[] { "Alex", "Sam" });
    }

    [Fact]
    public async Task EnsureOwnerMember_creates_one_when_none_exists_and_never_duplicates()
    {
        using var db = NewContext();

        await OwnerMemberSeeder.EnsureOwnerMemberAsync(db, "owner-1", "Sam");
        await OwnerMemberSeeder.EnsureOwnerMemberAsync(db, "owner-1", "Sam"); // idempotent

        var members = await db.HouseholdMembers.AsNoTracking().Where(m => m.OwnerId == "owner-1").ToListAsync();
        members.Should().ContainSingle();
        members[0].Name.Should().Be("Sam");
    }

    [Theory]
    [InlineData("Alex", "Alex M", "alex@x.com", "Alex")]
    [InlineData("  ", "Alex M", "alex@x.com", "Alex M")]
    [InlineData(null, null, "alex@x.com", "alex")]
    [InlineData(null, null, null, "You")]
    public void ResolveOwnerName_falls_back_first_name_then_display_then_email_then_generic(
        string? firstName, string? displayName, string? email, string expected)
    {
        OwnerMemberSeeder.ResolveOwnerName(firstName, displayName, email).Should().Be(expected);
    }
}
