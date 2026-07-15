using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// <see cref="HouseholdBootstrap.EnsureOwnHouseholdAsync"/> materializes a login's own household —
/// Owner membership + owner member, with the sample budget strictly opt-in — and is idempotent,
/// so it backs registration, the "start my own budget" path for a member who only ever joined
/// others, and the defensive leave-household path.
/// </summary>
public class HouseholdBootstrapTests
{
    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-bootstrap-{Guid.NewGuid()}")
            .Options);

    private static ApplicationUser User(string id) => new()
    {
        Id = id,
        UserName = $"{id}@x.com",
        Email = $"{id}@x.com",
        FirstName = "Sam",
        DisplayName = "Sam Solo",
    };

    private static readonly DateTime Now = new(2026, 7, 1, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task EnsureOwnHousehold_without_sample_creates_membership_and_owner_member_but_no_budget()
    {
        using var db = NewContext();
        var user = User("user-1");

        var created = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: false);

        created.Should().BeTrue();

        var membership = await db.HouseholdMemberships.SingleAsync();
        membership.OwnerId.Should().Be("user-1");
        membership.UserId.Should().Be("user-1");
        membership.Role.Should().Be(HouseholdRole.Owner);
        membership.Status.Should().Be(MembershipStatus.Active);

        // No sample data unless asked for: the household starts with zero budget months (and zero
        // jars — the sample "Emergency Fund" jar is part of the opt-in seed).
        (await db.BudgetMonths.AnyAsync(m => m.OwnerId == "user-1")).Should().BeFalse();
        (await db.Jars.AnyAsync(j => j.OwnerId == "user-1")).Should().BeFalse();

        var member = await db.HouseholdMembers.SingleAsync(m => m.OwnerId == "user-1");
        member.Name.Should().Be("Sam");
        // The owner's own membership is linked to their budget person (1:1 person↔login link).
        membership.MemberId.Should().Be(member.Id);
    }

    [Fact]
    public async Task EnsureOwnHousehold_with_sample_also_seeds_the_sample_budget()
    {
        using var db = NewContext();
        var user = User("user-1");

        var created = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: true);

        created.Should().BeTrue();

        var month = await db.BudgetMonths.SingleAsync(m => m.OwnerId == "user-1");
        month.Year.Should().Be(2026);
        month.Month.Should().Be(7);

        (await db.HouseholdMembers.CountAsync(m => m.OwnerId == "user-1")).Should().Be(1);
    }

    [Fact]
    public async Task EnsureOwnHousehold_is_idempotent_and_never_duplicates()
    {
        using var db = NewContext();
        var user = User("user-1");

        var first = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: true);
        var second = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: true);

        first.Should().BeTrue();
        second.Should().BeFalse(); // the Owner membership already existed the second time

        (await db.HouseholdMemberships.CountAsync(m => m.OwnerId == "user-1")).Should().Be(1);
        (await db.BudgetMonths.CountAsync(m => m.OwnerId == "user-1")).Should().Be(1);
        (await db.HouseholdMembers.CountAsync(m => m.OwnerId == "user-1")).Should().Be(1);
    }

    [Fact]
    public async Task A_later_sample_request_never_injects_figures_into_an_established_budget()
    {
        using var db = NewContext();
        var user = User("user-1");

        // Registered without sample data, then built a real month of their own.
        await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: false);
        db.BudgetMonths.Add(new BudgetMonth { OwnerId = "user-1", Year = 2026, Month = 6 });
        await db.SaveChangesAsync();

        // A later bootstrap asking for the seed (e.g. a re-used path) must respect the real budget.
        await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, Now, seedSampleBudget: true);

        var months = await db.BudgetMonths.Where(m => m.OwnerId == "user-1").ToListAsync();
        months.Should().ContainSingle().Which.Month.Should().Be(6);
    }

    [Fact]
    public async Task EnsureOwnHousehold_leaves_an_existing_joined_membership_untouched()
    {
        using var db = NewContext();
        // The user already belongs to someone else's household as a member (no own household yet).
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = "owner-other",
            UserId = "user-1",
            Role = HouseholdRole.Limited,
            Status = MembershipStatus.Active,
            InvitedEmail = "user-1@x.com",
        });
        await db.SaveChangesAsync();

        await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, User("user-1"), Now, seedSampleBudget: false);

        // They now have two memberships: the joined one, plus their own new Owner one.
        var mine = await db.HouseholdMemberships.Where(m => m.UserId == "user-1").ToListAsync();
        mine.Should().HaveCount(2);
        mine.Should().ContainSingle(m => m.OwnerId == "owner-other" && m.Role == HouseholdRole.Limited);
        mine.Should().ContainSingle(m => m.OwnerId == "user-1" && m.Role == HouseholdRole.Owner);
    }
}
