using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.CreateHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Household members: first-class people under one owner, each with a net income and a
/// derived share of the household total (the basis for the allocation split).
/// </summary>
public class HouseholdMembersTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-members-{Guid.NewGuid()}")
            .Options);

    private static async Task<HouseholdMember> Seed(ApplicationDbContext db, string ownerId, string name, decimal net, bool archived = false)
    {
        var m = new HouseholdMember { OwnerId = ownerId, Name = name, NetMonthlyIncome = net, IsArchived = archived };
        db.HouseholdMembers.Add(m);
        await db.SaveChangesAsync();
        return m;
    }

    [Fact]
    public async Task Create_SetsOwner_AndOrders()
    {
        await using var db = NewContext();
        var handler = new CreateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"));

        var a = await handler.Handle(new CreateHouseholdMemberCommand("Chris", 4411.64m, null), CancellationToken.None);
        var b = await handler.Handle(new CreateHouseholdMemberCommand("Liza", 3999.97m, null), CancellationToken.None);

        a.DisplayOrder.Should().Be(0);
        b.DisplayOrder.Should().Be(1);
        (await db.HouseholdMembers.CountAsync()).Should().Be(2);
        (await db.HouseholdMembers.FirstAsync(m => m.Name == "Chris")).OwnerId.Should().Be("user-1");
    }

    [Fact]
    public async Task Get_ComputesIncomeShare_AcrossActiveMembers()
    {
        await using var db = NewContext();
        await Seed(db, "user-1", "Chris", 6000m);
        await Seed(db, "user-1", "Liza", 4000m);

        var members = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);

        members.Single(m => m.Name == "Chris").IncomeSharePct.Should().Be(0.6m); // 6000 / 10000
        members.Single(m => m.Name == "Liza").IncomeSharePct.Should().Be(0.4m);
    }

    [Fact]
    public async Task Get_IsOwnerScoped_AndExcludesArchivedByDefault()
    {
        await using var db = NewContext();
        await Seed(db, "user-1", "Chris", 5000m);
        await Seed(db, "user-1", "Old", 1000m, archived: true);
        await Seed(db, "user-2", "Other", 9000m);

        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));

        var active = await handler.Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        active.Should().ContainSingle().Which.Name.Should().Be("Chris");

        var all = await handler.Handle(new GetHouseholdMembersQuery(IncludeArchived: true), CancellationToken.None);
        all.Should().HaveCount(2);
    }

    [Fact]
    public async Task Update_EditsFields()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Chris", 5000m);

        var dto = await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateHouseholdMemberCommand(m.Id, "Christopher", 5500m, null), CancellationToken.None);

        dto.Name.Should().Be("Christopher");
        dto.NetMonthlyIncome.Should().Be(5500m);
    }

    [Fact]
    public async Task Update_Throws_WhenOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Chris", 5000m);

        var handler = new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-2"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() => handler.Handle(
            new UpdateHouseholdMemberCommand(m.Id, "X", 1m, null), CancellationToken.None));
    }

    [Fact]
    public async Task Archive_HidesFromDefaultList()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Chris", 5000m);

        await new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveHouseholdMemberCommand(m.Id), CancellationToken.None);

        var active = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        active.Should().BeEmpty();
    }

    [Fact]
    public void Validator_RejectsEmptyName()
    {
        new CreateHouseholdMemberCommandValidator()
            .Validate(new CreateHouseholdMemberCommand("", 100m, null))
            .IsValid.Should().BeFalse();
    }
}
