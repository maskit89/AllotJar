using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Household.Queries.GetMemberIncome;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rule 28: the engine's pool is the month's budgeted income and nothing else. Lines
/// attributed to people are theirs; unattributed lines are shared equally (surfaced via the
/// DTO); the saved per-person default (NetMonthlyIncome) never supplies or tops up the pool,
/// and a month with no budget has none. Plus the /members/income derivation.
/// </summary>
public class AllocationIncomeFromBudgetTests
{
    private sealed record Seeded(HouseholdMember Alex, HouseholdMember Robin, BudgetCategory Income);

    private static Seeded Seed(ApplicationDbContext db, string owner = "user-1")
    {
        var alex = new HouseholdMember { OwnerId = owner, Name = "Alex", NetMonthlyIncome = 9999m, DisplayOrder = 0 };
        var robin = new HouseholdMember { OwnerId = owner, Name = "Robin", NetMonthlyIncome = 8888m, DisplayOrder = 1 };
        db.HouseholdMembers.AddRange(alex, robin);
        var income = new BudgetCategory { Name = "Income", Kind = CategoryKind.Income };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                income,
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = { new BudgetItem { Name = "Rent", PlannedAmount = 1000m } } },
            },
        });
        db.SaveChanges();
        return new Seeded(alex, robin, income);
    }

    private static void AddIncomeLine(ApplicationDbContext db, Seeded s, string name, decimal planned, Guid? memberId)
    {
        db.BudgetItems.Add(new BudgetItem
        {
            BudgetCategoryId = s.Income.Id, Name = name, PlannedAmount = planned, MemberId = memberId,
        });
        db.SaveChanges();
    }

    private static async Task SeedProfileAsync(ApplicationDbContext db, string owner = "user-1")
    {
        await new UpsertAllocationProfileCommandHandler(db, new CurrentUserStub(owner))
            .Handle(new UpsertAllocationProfileCommand(null, "P", null, new List<AllocationRuleSpec>
            {
                new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
                new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m),
                new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, 0m),
                new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
            }), CancellationToken.None);
    }

    [Fact]
    public async Task AttributedLines_DriveThePool_AndPerMemberIncome()
    {
        await using var db = NewContext();
        var s = Seed(db);
        await SeedProfileAsync(db);
        AddIncomeLine(db, s, "Alex — Salary", 3000m, s.Alex.Id);
        AddIncomeLine(db, s, "Robin — Salary", 2000m, s.Robin.Id);

        var dto = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        dto.UnattributedIncome.Should().Be(0m);
        // The pool is the budget's income, NOT the static 9999/8888 defaults.
        dto.Pool.Should().Be(5000m);
        dto.Members.Single(m => m.Name == "Alex").NetIncome.Should().Be(3000m);
        dto.Members.Single(m => m.Name == "Robin").NetIncome.Should().Be(2000m);
    }

    [Fact]
    public async Task UnattributedIncome_IsSharedEqually_LastMemberAbsorbsTheRemainder()
    {
        await using var db = NewContext();
        var s = Seed(db);
        await SeedProfileAsync(db);
        AddIncomeLine(db, s, "Alex — Salary", 3000m, s.Alex.Id);
        // The split convention is sum-preserving (last member absorbs whatever rounding
        // leaves over), so assert the invariant rather than a fragile exact cent.
        AddIncomeLine(db, s, "Child benefit", 100.01m, null);

        var dto = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        dto.UnattributedIncome.Should().Be(100.01m);
        dto.Pool.Should().Be(3100.01m);
        // Sum-preserving: whatever the rounding, the shares add back to the unattributed total.
        var alex = dto.Members.Single(m => m.Name == "Alex").NetIncome;
        var robin = dto.Members.Single(m => m.Name == "Robin").NetIncome;
        (alex + robin).Should().Be(3100.01m);
        alex.Should().BeGreaterThan(3000m);
        robin.Should().BeGreaterThan(0m);
    }

    [Fact]
    public async Task NoAttributedLines_ShareTheUnattributedIncomeEqually_AndIgnoreTheSavedDefaults()
    {
        await using var db = NewContext();
        var s = Seed(db);
        await SeedProfileAsync(db);
        // Income exists but nothing is attributed — the whole line is the household's, shared
        // equally; the 9999/8888 defaults on the members play no part (rule 28).
        AddIncomeLine(db, s, "Take-home Pay", 4000m, null);

        var dto = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        dto.UnattributedIncome.Should().Be(4000m);
        dto.Pool.Should().Be(4000m);
        dto.Members.Single(m => m.Name == "Alex").NetIncome.Should().Be(2000m);
        dto.Members.Single(m => m.Name == "Robin").NetIncome.Should().Be(2000m);
    }

    [Fact]
    public async Task NoBudget_YieldsAnEmptyPool_NotTheDefaults()
    {
        await using var db = NewContext();
        Seed(db); // the members carry 9999/8888 defaults; only July 2026 has a budget
        await SeedProfileAsync(db);

        // August has no budget month at all.
        var dto = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 8, null), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        dto.UnattributedIncome.Should().Be(0m);
        dto.Pool.Should().Be(0m, "the saved defaults are never a pool or a fallback");
        dto.Members.Should().HaveCount(2).And.OnlyContain(m => m.NetIncome == 0m);
    }

    [Fact]
    public async Task LinesAttributedToArchivedMembers_FoldIntoUnattributed()
    {
        await using var db = NewContext();
        var s = Seed(db);
        await SeedProfileAsync(db);
        AddIncomeLine(db, s, "Alex — Salary", 3000m, s.Alex.Id);
        AddIncomeLine(db, s, "Robin — Salary", 2000m, s.Robin.Id);
        s.Robin.IsArchived = true;
        await db.SaveChangesAsync();

        var dto = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        // Robin is gone: their line becomes whole-household income for the remaining member.
        dto.UnattributedIncome.Should().Be(2000m);
        dto.Members.Should().ContainSingle();
        dto.Members.Single().NetIncome.Should().Be(5000m);
    }

    [Fact]
    public async Task GetMemberIncome_DerivesPlannedAndReceived_MonthScoped()
    {
        await using var db = NewContext();
        var s = Seed(db);
        AddIncomeLine(db, s, "Alex — Salary", 3000m, s.Alex.Id);
        AddIncomeLine(db, s, "Child benefit", 100m, null);
        // Received: one whole income tx in-month, one out-of-month, one split slice.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 7, 5), Payee = "Employer",
            Amount = 1500m, Type = TransactionType.Income, MemberId = s.Alex.Id,
        });
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 28), Payee = "Employer",
            Amount = 999m, Type = TransactionType.Income, MemberId = s.Alex.Id,
        });
        var splitTx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 7, 10), Payee = "Joint refund",
            Amount = 100m, Type = TransactionType.Income,
        };
        db.Transactions.Add(splitTx);
        db.SaveChanges();
        db.TransactionSplits.Add(new TransactionSplit
        {
            TransactionId = splitTx.Id, BudgetItemId = db.BudgetItems.First(i => i.Name == "Alex — Salary").Id,
            MemberId = s.Robin.Id, Amount = 100m,
        });
        db.SaveChanges();

        var dto = await new GetMemberIncomeQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetMemberIncomeQuery(2026, 7), CancellationToken.None);

        dto.IncomeFromBudget.Should().BeTrue();
        dto.UnattributedPlanned.Should().Be(100m);
        var alex = dto.Items.Single(i => i.Name == "Alex");
        alex.Planned.Should().Be(3000m);
        alex.Received.Should().Be(1500m, "the June transaction is out of the window");
        dto.Items.Single(i => i.Name == "Robin").Received.Should().Be(100m, "split slices attribute per member");
    }
}
