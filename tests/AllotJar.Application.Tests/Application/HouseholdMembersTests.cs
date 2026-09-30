using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.CreateHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Household members: first-class people under one owner, each with a saved default income
/// (a helper for filling in a new budget) and a share of the household's income in the
/// selected month's budget (the basis for the allocation split, rule 28).
/// </summary>
public class HouseholdMembersTests
{
    private static async Task<HouseholdMember> Seed(ApplicationDbContext db, string ownerId, string name, decimal net, bool archived = false)
    {
        var m = new HouseholdMember { OwnerId = ownerId, Name = name, NetMonthlyIncome = net, IsArchived = archived };
        db.HouseholdMembers.Add(m);
        await db.SaveChangesAsync();
        return m;
    }

    /// <summary>A budget month whose income lines are attributed to the given members (rule 28).</summary>
    private static async Task SeedIncomeMonth(
        ApplicationDbContext db, string ownerId, int year, int month, params (HouseholdMember Member, decimal Amount)[] lines)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income,
                    Items = lines.Select(l => new BudgetItem { Name = l.Member.Name, PlannedAmount = l.Amount, MemberId = l.Member.Id }).ToList(),
                },
            },
        });
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Create_SetsOwner_AndOrders()
    {
        await using var db = NewContext();
        var handler = new CreateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"));

        var a = await handler.Handle(new CreateHouseholdMemberCommand("Alex", 4200.50m, null), CancellationToken.None);
        var b = await handler.Handle(new CreateHouseholdMemberCommand("Sam", 3800.25m, null), CancellationToken.None);

        a.DisplayOrder.Should().Be(0);
        b.DisplayOrder.Should().Be(1);
        (await db.HouseholdMembers.CountAsync()).Should().Be(2);
        (await db.HouseholdMembers.FirstAsync(m => m.Name == "Alex")).OwnerId.Should().Be("user-1");
    }

    [Fact]
    public async Task Get_ComputesIncomeShare_AcrossActiveMembers()
    {
        // The shares come from the selected month's budget, not the saved defaults (which are
        // deliberately different here so they cannot be what is being divided).
        await using var db = NewContext();
        var alex = await Seed(db, "user-1", "Alex", 1m);
        var sam = await Seed(db, "user-1", "Sam", 1m);
        await SeedIncomeMonth(db, "user-1", 2026, 7, (alex, 6000m), (sam, 4000m));

        var members = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 7), CancellationToken.None);

        members.Single(m => m.Name == "Alex").IncomeSharePct.Should().Be(0.6m); // 6000 / 10000
        members.Single(m => m.Name == "Sam").IncomeSharePct.Should().Be(0.4m);
        members.Single(m => m.Name == "Alex").BudgetIncome.Should().Be(6000m);
        members.Single(m => m.Name == "Sam").BudgetIncome.Should().Be(4000m);
        members.Should().OnlyContain(m => m.HasBudget && m.IncomeYear == 2026 && m.IncomeMonth == 7);
    }

    [Fact]
    public async Task Get_IsOwnerScoped_AndExcludesArchivedByDefault()
    {
        await using var db = NewContext();
        await Seed(db, "user-1", "Alex", 5000m);
        await Seed(db, "user-1", "Old", 1000m, archived: true);
        await Seed(db, "user-2", "Other", 9000m);

        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));

        var active = await handler.Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        active.Should().ContainSingle().Which.Name.Should().Be("Alex");

        var all = await handler.Handle(new GetHouseholdMembersQuery(IncludeArchived: true), CancellationToken.None);
        all.Should().HaveCount(2);
    }

    [Fact]
    public async Task Update_EditsFields()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Alex", 5000m);

        var dto = await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateHouseholdMemberCommand(m.Id, "Christopher", 5500m, null), CancellationToken.None);

        dto.Name.Should().Be("Christopher");
        dto.NetMonthlyIncome.Should().Be(5500m);
    }

    [Fact]
    public async Task Update_LinksAnOwnedSavingsAccount()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Alex", 5000m);
        var account = new Account { OwnerId = "user-1", Name = "Alex Savings", Currency = CurrencyCode.Eur, DisplayOrder = 0 };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();

        var dto = await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateHouseholdMemberCommand(m.Id, "Alex", 5000m, account.Id), CancellationToken.None);

        dto.PersonalSavingsAccountId.Should().Be(account.Id);
    }

    [Fact]
    public async Task Update_Throws_WhenOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var m = await Seed(db, "user-1", "Alex", 5000m);

        var handler = new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-2"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() => handler.Handle(
            new UpdateHouseholdMemberCommand(m.Id, "X", 1m, null), CancellationToken.None));
    }

    [Fact]
    public void Validator_RejectsEmptyName()
    {
        new CreateHouseholdMemberCommandValidator()
            .Validate(new CreateHouseholdMemberCommand("", 100m, null))
            .IsValid.Should().BeFalse();
    }

    // --- Self-transfer guard, member side (2026-07-22 re-review F8): a member's personal
    // savings account can't be an allocation profile's SOURCE account. -----------------------

    private static Account SeedAccount(ApplicationDbContext db, string ownerId, string name)
    {
        var a = new Account { OwnerId = ownerId, Name = name, Currency = CurrencyCode.Eur };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static void SeedProfileWithSource(ApplicationDbContext db, string ownerId, Guid sourceAccountId)
    {
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = ownerId, Name = "Monthly", SourceAccountId = sourceAccountId,
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task Create_Rejects_ASavingsAccountThatIsTheAllocationSource()
    {
        await using var db = NewContext();
        var source = SeedAccount(db, "user-1", "Joint Current");
        SeedProfileWithSource(db, "user-1", source.Id);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            new CreateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new CreateHouseholdMemberCommand("Alex", 3000m, source.Id), CancellationToken.None));

        ex.Errors["PersonalSavingsAccountId"].Single().Should().Contain("Monthly");
        (await db.HouseholdMembers.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Update_Rejects_ASavingsAccountThatIsTheAllocationSource()
    {
        await using var db = NewContext();
        var member = await Seed(db, "user-1", "Alex", 3000m);
        var source = SeedAccount(db, "user-1", "Joint Current");
        SeedProfileWithSource(db, "user-1", source.Id);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new UpdateHouseholdMemberCommand(member.Id, "Alex", 3000m, source.Id), CancellationToken.None));

        ex.Errors["PersonalSavingsAccountId"].Single().Should().Contain("Monthly");
        (await db.HouseholdMembers.SingleAsync(m => m.Id == member.Id)).PersonalSavingsAccountId.Should().BeNull();
    }
}
