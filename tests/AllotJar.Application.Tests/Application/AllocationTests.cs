using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Queries.GetAllocationProfile;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The income allocation engine end-to-end: profile CRUD, the preview waterfall driven
/// by the month's budget totals, and the idempotent commit that routes each member's
/// surplus into their savings.
/// </summary>
public class AllocationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-alloc-{Guid.NewGuid()}")
            .Options);

    private static Account SeedAccount(ApplicationDbContext db, string owner, string name, decimal opening = 0m)
    {
        var a = new Account { OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = opening };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static void SeedMember(ApplicationDbContext db, string owner, string name, decimal net, int order, Guid? savings)
    {
        db.HouseholdMembers.Add(new HouseholdMember
        {
            OwnerId = owner, Name = name, NetMonthlyIncome = net, DisplayOrder = order, PersonalSavingsAccountId = savings,
        });
        db.SaveChanges();
    }

    private static void SeedBudget(ApplicationDbContext db, string owner, int year, int month, decimal envelopes, decimal funds)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = owner, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = envelopes } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = funds } } },
            },
        });
        db.SaveChanges();
    }

    private static List<AllocationRuleSpec> StandardRules() => new()
    {
        new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
        new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m),
        new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, 250m),
        new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
    };

    [Fact]
    public async Task Upsert_CreatesProfileWithRules_AndGetReturnsIt()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");

        var created = await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "From Jan 2026", null, StandardRules()), CancellationToken.None);

        created.Rules.Should().HaveCount(4);
        created.Rules.Select(r => r.Type).Should().ContainInOrder(
            AllocationRuleType.FundEnvelopes, AllocationRuleType.FundJars,
            AllocationRuleType.FixedPerMember, AllocationRuleType.SplitRemainderToMembers);

        var fetched = await new GetAllocationProfileQueryHandler(db, user)
            .Handle(new GetAllocationProfileQuery(), CancellationToken.None);
        fetched!.Name.Should().Be("From Jan 2026");
        fetched.Rules.Should().HaveCount(4);
    }

    [Fact]
    public async Task Preview_ReproducesWaterfall_FromBudgetTotals()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMember(db, "user-1", "Chris", 4411.64m, 0, null);
        SeedMember(db, "user-1", "Liza", 3999.97m, 1, null);
        SeedBudget(db, "user-1", 2026, 6, envelopes: 3641m, funds: 2164m);
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", null, StandardRules()), CancellationToken.None);

        var result = await new PreviewIncomeAllocationQueryHandler(db, user)
            .Handle(new PreviewIncomeAllocationQuery(2026, 6), CancellationToken.None);

        result.Pool.Should().Be(8411.61m);
        result.EnvelopesTotal.Should().Be(3641m);
        result.JarsTotal.Should().Be(2164m);
        // StandardRules' terminal step splits the 2106.61 surplus Equally (pooled), so each member
        // saves half; the deduction waterfall (pool − 3641 − 2164 − 500) is what's being validated.
        result.Members.Sum(m => m.Residual).Should().Be(2106.61m);
        result.Members.Single(m => m.Name == "Chris").Residual.Should().Be(1053.31m);
        result.Members.Single(m => m.Name == "Liza").Residual.Should().Be(1053.30m);
    }

    [Fact]
    public async Task Preview_ExcludesFlaggedCategories_AndTiltsSurplusToTheLowerBalance()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var chrisSavings = SeedAccount(db, "user-1", "Chris Savings", opening: 35631.96m);
        var lizaSavings = SeedAccount(db, "user-1", "Liza Savings", opening: 46033.38m);
        SeedMember(db, "user-1", "Chris", 4411.64m, 0, chrisSavings.Id);
        SeedMember(db, "user-1", "Liza", 3999.97m, 1, lizaSavings.Id);

        // Real costs (3641 + 2164) plus a "Personal Savings" category that is the allocation
        // *output* — flagged out so it isn't double-counted as an obligation.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = 3641m } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = 2164m } } },
                new() { Name = "Personal Savings", Kind = CategoryKind.Expense, ExcludeFromAllocation = true, Items = new List<BudgetItem> { new() { Name = "Surplus", PlannedAmount = 9999m } } },
            },
        });
        db.SaveChanges();

        var rules = new List<AllocationRuleSpec>
        {
            new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
            new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m),
            new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, 250m),
            new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m),
        };
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", null, rules, BalanceLeanPercent: 25), CancellationToken.None);

        var result = await new PreviewIncomeAllocationQueryHandler(db, user)
            .Handle(new PreviewIncomeAllocationQuery(2026, 6), CancellationToken.None);

        // The flagged 9999 category is ignored, so obligations are just the real costs.
        result.EnvelopesTotal.Should().Be(3641m);
        result.JarsTotal.Should().Be(2164m);

        var chris = result.Members.Single(m => m.Name == "Chris");
        var liza = result.Members.Single(m => m.Name == "Liza");
        chris.SavingsBalance.Should().Be(35631.96m);
        liza.SavingsBalance.Should().Be(46033.38m);
        // Whole surplus preserved (2106.61) and tilted toward Chris's lower balance.
        (chris.Residual + liza.Residual).Should().Be(2106.61m);
        chris.Residual.Should().Be(1316.63m);
        liza.Residual.Should().Be(789.98m);
    }

    [Fact]
    public async Task Allocate_CreatesMemberSavingsTransfers_AndIsIdempotent()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var source = SeedAccount(db, "user-1", "Joint Current");
        var chrisSavings = SeedAccount(db, "user-1", "Chris Savings");
        var lizaSavings = SeedAccount(db, "user-1", "Liza Savings");
        SeedMember(db, "user-1", "Chris", 4411.64m, 0, chrisSavings.Id);
        SeedMember(db, "user-1", "Liza", 3999.97m, 1, lizaSavings.Id);
        SeedBudget(db, "user-1", 2026, 6, envelopes: 3641m, funds: 2164m);
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", source.Id, StandardRules()), CancellationToken.None);

        var commit = new AllocateIncomeCommandHandler(db, user);
        var first = await commit.Handle(new AllocateIncomeCommand(2026, 6), CancellationToken.None);

        first.TransfersCreated.Should().Be(2);
        var transfers = await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync();
        transfers.Should().HaveCount(2);
        // Equal terminal split pools the 2106.61 surplus evenly into each member's savings account.
        transfers.Should().ContainSingle(t => t.TransferAccountId == chrisSavings.Id && t.Amount == 1053.31m);
        transfers.Should().ContainSingle(t => t.TransferAccountId == lizaSavings.Id && t.Amount == 1053.30m);
        transfers.Sum(t => t.Amount).Should().Be(2106.61m);

        // Re-running replaces, not appends.
        var second = await commit.Handle(new AllocateIncomeCommand(2026, 6), CancellationToken.None);
        second.TransfersCreated.Should().Be(2);
        (await db.Transactions.CountAsync(t => t.Type == TransactionType.Transfer)).Should().Be(2);
    }

    // The tester's incoherence scenario: a budget balanced WITHOUT pocket lines forces the
    // engine's remainder to exactly minus the pocket total (zero transfers), and the sync's
    // flagged lines are what reconcile the two systems.
    [Fact]
    public async Task BalancedBudgetWithoutPocketLines_ForcesNegativeRemainder_UntilSyncMaterializesThem()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var source = SeedAccount(db, "user-1", "Joint");
        var aSav = SeedAccount(db, "user-1", "A Savings");
        var bSav = SeedAccount(db, "user-1", "B Savings");
        SeedMember(db, "user-1", "A", 1500m, 0, aSav.Id);
        SeedMember(db, "user-1", "B", 1500m, 1, bSav.Id);
        // Pool 3,000 fully budgeted: envelopes 2,500 + jars 500. Pocket 250 each exists ONLY
        // as the FixedPerMember rule.
        SeedBudget(db, "user-1", 2026, 6, envelopes: 2500m, funds: 500m);
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", source.Id, StandardRules()), CancellationToken.None);

        var commit = new AllocateIncomeCommandHandler(db, user);
        var before = await commit.Handle(new AllocateIncomeCommand(2026, 6), CancellationToken.None);

        // Each member: 1500 − 1250 − 250 = −250; remainder −500 → keep-own, zero transfers.
        before.TransfersCreated.Should().Be(0);
        before.Members.Should().OnlyContain(m => m.Residual == -250m);

        // The sync reshapes the budget: pocket becomes flagged lines. Trim envelopes by the
        // pocket total (what the banner tells the user to do) and both systems land on zero.
        var living = await db.BudgetItems.SingleAsync(i => i.Name == "Living");
        living.PlannedAmount = 2000m;
        await db.SaveChangesAsync();
        await new SyncPocketMoneyLinesCommandHandler(db, user)
            .Handle(new SyncPocketMoneyLinesCommand(2026, 6), CancellationToken.None);

        var after = await commit.Handle(new AllocateIncomeCommand(2026, 6), CancellationToken.None);

        // Engine: 3000 − 2000 − 500 − 500(pocket rule) = 0 remainder; budget: planned
        // 2000 + 500 + 500(flagged pocket lines) = income 3000 — both coherent.
        after.EnvelopesTotal.Should().Be(2000m, "the flagged pocket lines must not re-enter the envelopes");
        after.Members.Should().OnlyContain(m => m.Residual == 0m);
        after.TransfersCreated.Should().Be(0);
    }
}
