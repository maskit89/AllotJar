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
        var a = new Account { OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = opening, OpeningDate = new DateOnly(2026, 1, 1) };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static HouseholdMember SeedMember(ApplicationDbContext db, string owner, string name, decimal net, int order, Guid? savings)
    {
        var m = new HouseholdMember
        {
            OwnerId = owner, Name = name, NetMonthlyIncome = net, DisplayOrder = order, PersonalSavingsAccountId = savings,
        };
        db.HouseholdMembers.Add(m);
        db.SaveChanges();
        return m;
    }

    /// <summary>
    /// The month's income, the only pool the engine reads (rule 28): one attributed income line
    /// per member in the given month's budget (which must already exist).
    /// </summary>
    private static void SeedIncomeLines(ApplicationDbContext db, string owner, int year, int month, params (HouseholdMember Member, decimal Amount)[] lines)
    {
        var bm = db.BudgetMonths.Single(b => b.OwnerId == owner && b.Year == year && b.Month == month);
        db.BudgetCategories.Add(new BudgetCategory
        {
            BudgetMonthId = bm.Id, Name = "Income", Kind = CategoryKind.Income,
            Items = lines.Select(l => new BudgetItem { Name = l.Member.Name, PlannedAmount = l.Amount, MemberId = l.Member.Id }).ToList(),
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
        var alex = SeedMember(db, "user-1", "Alex", 4200.50m, 0, null);
        var sam = SeedMember(db, "user-1", "Sam", 3800.25m, 1, null);
        SeedBudget(db, "user-1", 2026, 6, envelopes: 3500m, funds: 2000m);
        SeedIncomeLines(db, "user-1", 2026, 6, (alex, 4200.50m), (sam, 3800.25m));
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", null, StandardRules()), CancellationToken.None);

        var result = await new PreviewIncomeAllocationQueryHandler(db, user)
            .Handle(new PreviewIncomeAllocationQuery(2026, 6), CancellationToken.None);

        result.Pool.Should().Be(8000.75m);
        result.EnvelopesTotal.Should().Be(3500m);
        result.JarsTotal.Should().Be(2000m);
        // StandardRules' terminal step splits the 2000.75 surplus Equally (pooled), so each member
        // saves half; the deduction waterfall (pool − 3500 − 2000 − 500) is what's being validated.
        result.Members.Sum(m => m.Residual).Should().Be(2000.75m);
        result.Members.Single(m => m.Name == "Alex").Residual.Should().Be(1000.38m);
        result.Members.Single(m => m.Name == "Sam").Residual.Should().Be(1000.37m);
    }

    [Fact]
    public async Task Preview_ExcludesFlaggedCategories_AndTiltsSurplusToTheLowerBalance()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var chrisSavings = SeedAccount(db, "user-1", "Alex Savings", opening: 30000m);
        var lizaSavings = SeedAccount(db, "user-1", "Sam Savings", opening: 40000m);
        var alex = SeedMember(db, "user-1", "Alex", 4200.50m, 0, chrisSavings.Id);
        var sam = SeedMember(db, "user-1", "Sam", 3800.25m, 1, lizaSavings.Id);

        // Real costs (3500 + 2000) plus a "Personal Savings" category that is the allocation
        // *output* — flagged out so it isn't double-counted as an obligation.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = 3500m } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = 2000m } } },
                new() { Name = "Personal Savings", Kind = CategoryKind.Expense, ExcludeFromAllocation = true, Items = new List<BudgetItem> { new() { Name = "Surplus", PlannedAmount = 9999m } } },
            },
        });
        db.SaveChanges();
        SeedIncomeLines(db, "user-1", 2026, 6, (alex, 4200.50m), (sam, 3800.25m));

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
        result.EnvelopesTotal.Should().Be(3500m);
        result.JarsTotal.Should().Be(2000m);

        var alex = result.Members.Single(m => m.Name == "Alex");
        var sam = result.Members.Single(m => m.Name == "Sam");
        alex.SavingsBalance.Should().Be(30000m);
        sam.SavingsBalance.Should().Be(40000m);
        // Whole surplus preserved (2000.75) and tilted toward Alex's lower balance.
        (alex.Residual + sam.Residual).Should().Be(2000.75m);
        alex.Residual.Should().Be(1250.47m);
        sam.Residual.Should().Be(750.28m);
    }

    [Fact]
    public async Task Allocate_CreatesMemberSavingsTransfers_AndIsIdempotent()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var source = SeedAccount(db, "user-1", "Joint Current", opening: 100_000m);
        var chrisSavings = SeedAccount(db, "user-1", "Alex Savings");
        var lizaSavings = SeedAccount(db, "user-1", "Sam Savings");
        var alex = SeedMember(db, "user-1", "Alex", 4200.50m, 0, chrisSavings.Id);
        var sam = SeedMember(db, "user-1", "Sam", 3800.25m, 1, lizaSavings.Id);
        SeedBudget(db, "user-1", 2026, 6, envelopes: 3500m, funds: 2000m);
        SeedIncomeLines(db, "user-1", 2026, 6, (alex, 4200.50m), (sam, 3800.25m));
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", source.Id, StandardRules()), CancellationToken.None);

        var commit = new AllocateIncomeCommandHandler(db, user);
        var first = await commit.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 1), ConfirmedCompleted: true), CancellationToken.None);

        first.TransfersCreated.Should().Be(2);
        var transfers = await db.Transactions.Where(t => t.Type == TransactionType.Transfer).ToListAsync();
        transfers.Should().HaveCount(2);
        // Equal terminal split pools the 2000.75 surplus evenly into each member's savings account.
        transfers.Should().ContainSingle(t => t.TransferAccountId == chrisSavings.Id && t.Amount == 1000.38m);
        transfers.Should().ContainSingle(t => t.TransferAccountId == lizaSavings.Id && t.Amount == 1000.37m);
        transfers.Sum(t => t.Amount).Should().Be(2000.75m);

        // Every recorded transfer is a confirmed departure with receipt still unknown (rule 71):
        // the commit records what the user says they did, never an arrival it cannot know.
        transfers.Should().OnlyContain(t => t.DepartedOn == new DateOnly(2026, 6, 1) && t.ReceivedOn == null);

        // Re-running neither appends nor rewrites an unchanged recorded transfer (rules 7/29):
        // the same two movements stay as recorded, so nothing new is created.
        var second = await commit.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 1), ConfirmedCompleted: true), CancellationToken.None);
        second.TransfersCreated.Should().Be(0);
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
        var source = SeedAccount(db, "user-1", "Joint", opening: 100_000m);
        var aSav = SeedAccount(db, "user-1", "A Savings");
        var bSav = SeedAccount(db, "user-1", "B Savings");
        var a = SeedMember(db, "user-1", "A", 1500m, 0, aSav.Id);
        var b = SeedMember(db, "user-1", "B", 1500m, 1, bSav.Id);
        // Pool 3,000 (the month's attributed income lines) fully budgeted: envelopes 2,500 +
        // jars 500. Pocket 250 each exists ONLY as the FixedPerMember rule.
        SeedBudget(db, "user-1", 2026, 6, envelopes: 2500m, funds: 500m);
        SeedIncomeLines(db, "user-1", 2026, 6, (a, 1500m), (b, 1500m));
        await new UpsertAllocationProfileCommandHandler(db, user)
            .Handle(new UpsertAllocationProfileCommand(null, "P", source.Id, StandardRules()), CancellationToken.None);

        var commit = new AllocateIncomeCommandHandler(db, user);
        var before = await commit.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 1), ConfirmedCompleted: true), CancellationToken.None);

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

        var after = await commit.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 1), ConfirmedCompleted: true), CancellationToken.None);

        // Engine: 3000 − 2000 − 500 − 500(pocket rule) = 0 remainder; budget: planned
        // 2000 + 500 + 500(flagged pocket lines) = income 3000 — both coherent.
        after.EnvelopesTotal.Should().Be(2000m, "the flagged pocket lines must not re-enter the envelopes");
        after.Members.Should().OnlyContain(m => m.Residual == 0m);
        after.TransfersCreated.Should().Be(0);
    }

    // --- Self-transfer guards (2026-07-22 re-review F8): a member's savings account can never
    // be the allocation source — commit, profile save and member save all refuse it. ------------

    [Fact]
    public async Task Allocate_Rejects_WhenAMembersSavingsAccountIsTheSourceAccount()
    {
        // Data written before the save-time guards existed: member savings == profile source.
        // Committing would book a no-op self-transfer (zero balance effect) and still report
        // TransfersCreated = 1 as success.
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var source = SeedAccount(db, "user-1", "Joint Current", opening: 100_000m);
        var alex = SeedMember(db, "user-1", "Alex", 3000m, 0, source.Id); // savings IS the source
        SeedBudget(db, "user-1", 2026, 6, envelopes: 1000m, funds: 500m);
        SeedIncomeLines(db, "user-1", 2026, 6, (alex, 3000m));
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = "user-1", Name = "P", SourceAccountId = source.Id,
            Rules = new List<AllocationRule>
            {
                new() { Order = 0, Type = AllocationRuleType.FundEnvelopes, Split = SplitMethod.Equal },
                new() { Order = 1, Type = AllocationRuleType.FundJars, Split = SplitMethod.Equal },
                new() { Order = 2, Type = AllocationRuleType.SplitRemainderToMembers, Split = SplitMethod.Equal },
            },
        });
        await db.SaveChangesAsync();

        var ex = await Assert.ThrowsAsync<AllotJar.Application.Common.Exceptions.ValidationException>(() =>
            new AllocateIncomeCommandHandler(db, user)
                .Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 1), ConfirmedCompleted: true), CancellationToken.None));

        ex.Errors["Allocation"].Single().Should().Contain("source account");
        (await db.Transactions.CountAsync()).Should().Be(0); // no transfers, and the prior ones weren't dropped
    }

    [Fact]
    public async Task Upsert_Rejects_ASourceAccountThatIsAMembersSavingsAccount()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var savings = SeedAccount(db, "user-1", "Alex Savings");
        SeedMember(db, "user-1", "Alex", 3000m, 0, savings.Id);

        var ex = await Assert.ThrowsAsync<AllotJar.Application.Common.Exceptions.ValidationException>(() =>
            new UpsertAllocationProfileCommandHandler(db, user)
                .Handle(new UpsertAllocationProfileCommand(null, "P", savings.Id, StandardRules()), CancellationToken.None));

        ex.Errors["SourceAccountId"].Single().Should().Contain("Alex");
        (await db.AllocationProfiles.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Upsert_Rejects_ASourceAccountTheCallerDoesNotOwn()
    {
        await using var db = NewContext();
        var foreign = SeedAccount(db, "user-2", "Their account");

        await Assert.ThrowsAsync<AllotJar.Application.Common.Exceptions.NotFoundException>(() =>
            new UpsertAllocationProfileCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new UpsertAllocationProfileCommand(null, "P", foreign.Id, StandardRules()), CancellationToken.None));
    }
}
