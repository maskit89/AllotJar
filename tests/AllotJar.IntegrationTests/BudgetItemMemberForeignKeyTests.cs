using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.SetBudgetItemMember;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// BudgetItems.MemberId is a new enforced FK to HouseholdMembers (SetNull) that the
/// in-memory suite can't validate. These prove the real schema: the attribution write
/// path satisfies the FK, a bogus id is rejected by SQL Server, and hard-deleting a
/// member nulls the attribution instead of orphaning or cascading the line.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class BudgetItemMemberForeignKeyTests
{
    private readonly SqlServerFixture _fixture;

    public BudgetItemMemberForeignKeyTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private sealed record Seeded(Guid IncomeLineId, HouseholdMember Alex);

    private static async Task<Seeded> SeedAsync(ApplicationDbContext db, string ownerId)
    {
        var pay = new BudgetItem { Name = "Alex — Salary", PlannedAmount = 3000m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = 2026, Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = { pay } },
            },
        });
        var alex = new HouseholdMember { OwnerId = ownerId, Name = "Alex", NetMonthlyIncome = 3000m };
        db.HouseholdMembers.Add(alex);
        await db.SaveChangesAsync();
        return new Seeded(pay.Id, alex);
    }

    [Fact]
    public async Task SetMember_Persists_AgainstTheEnforcedFk()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var s = await SeedAsync(db, owner);

        var dto = await new SetBudgetItemMemberCommandHandler(db, new CurrentUserStub(owner))
            .Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, s.Alex.Id), CancellationToken.None);

        dto.Categories.Single(c => c.Kind == "Income").Items.Single().MemberId.Should().Be(s.Alex.Id);
    }

    [Fact]
    public async Task BogusMemberId_IsRejectedBySqlServer()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var s = await SeedAsync(db, owner);

        var line = await db.BudgetItems.SingleAsync(i => i.Id == s.IncomeLineId);
        line.MemberId = Guid.NewGuid(); // no such member — the handler would 404 first; this proves the schema net
        var act = () => db.SaveChangesAsync();

        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task DeletingAMember_SetsTheAttributionNull_KeepingTheLine()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var s = await SeedAsync(db, owner);
        await new SetBudgetItemMemberCommandHandler(db, new CurrentUserStub(owner))
            .Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, s.Alex.Id), CancellationToken.None);

        await using (var deleter = _fixture.CreateContext())
        {
            var alex = await deleter.HouseholdMembers.SingleAsync(m => m.Id == s.Alex.Id);
            deleter.HouseholdMembers.Remove(alex);
            await deleter.SaveChangesAsync();
        }

        await using var verify = _fixture.CreateContext();
        var line = await verify.BudgetItems.AsNoTracking().SingleAsync(i => i.Id == s.IncomeLineId);
        line.MemberId.Should().BeNull("the FK is SetNull — budget history outlives the person");
    }
}
