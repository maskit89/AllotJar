using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// W05 — period consistency (rules 48–49): the jars read for a budget month carry that month's
/// figures. A past month reads its balances as of its last day and its plan, contributed and to-go
/// from that month (rule 48's example: 300 at September's end, 100 more in October → September
/// shows 300 while today's balance is 400); a month that has not begun shows today's balance with
/// nothing contributed yet and its own line as the plan; a correction dated in a past month changes
/// that month's figure and carries forward (rule 49); and the Budget grid's Available agrees with
/// the shelf on every month. Rule 40 (the opening balance already includes everything before its
/// date) is pinned in <c>AccountLedgerActivationTests</c> and <c>AccountBalanceGuardTests</c>.
/// </summary>
public class JarMonthViewW05Tests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    // A fixed "today" so the maths are deterministic: October is the current month, September
    // is over and November has not begun.
    private static readonly DateOnly Today = new(2026, 10, 10);
    private static readonly DateOnly September = new(2026, 9, 1);
    private static readonly DateOnly October = new(2026, 10, 1);
    private static readonly DateOnly November = new(2026, 11, 1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-w05-{Guid.NewGuid()}")
            .Options);

    private static CurrentUserStub User() => new(Owner);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, decimal target = 1200m)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = target, TargetDate = new DateOnly(2027, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static BudgetItem SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar, decimal planned)
    {
        var line = new BudgetItem { Name = jar.Name, PlannedAmount = planned, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    /// <summary>The jar's figures for <paramref name="month"/> as the Budget page's shelf asks for them (today injected).</summary>
    private static async Task<JarDto> ReadAsync(ApplicationDbContext db, DateOnly? month) =>
        (await new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(AsOf: Today, Month: month), CancellationToken.None)).Single();

    private static async Task<decimal?> GridAvailableAsync(ApplicationDbContext db, DateOnly month) =>
        (await new GetBudgetMonthQueryHandler(db, User()).Handle(new GetBudgetMonthQuery(month.Year, month.Month), CancellationToken.None))
        .Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable;

    /// <summary>
    /// 200 in the jar since August, 100 more on 15 September, 100 more on 5 October; a line of
    /// 100 in September, 120 in October and 130 in November.
    /// </summary>
    private static (Account Account, Jar Jar) SeedHistory(ApplicationDbContext db)
    {
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var jar = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 200m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, new DateOnly(2026, 9, 15), JarAllocationKind.Reallocation);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, new DateOnly(2026, 10, 5), JarAllocationKind.Reallocation);
        SeedMonth(db, September, jar, 100m);
        SeedMonth(db, October, jar, 120m);
        SeedMonth(db, November, jar, 130m);
        return (account, jar);
    }

    [Fact]
    public async Task Rule48_APastMonth_ReadsAsOfItsEnd_WithThatMonthsPlanContributedAndToGo()
    {
        await using var db = NewContext();
        SeedHistory(db);

        var september = await ReadAsync(db, September);

        // The balance at September's end, not today's 400 (rule 48's example).
        september.CurrentBalance.Should().Be(300m);
        september.BalanceAsOf.Should().Be(new DateOnly(2026, 9, 30));
        // September's own line, what arrived during September, and what was still to go (rule 14 read back).
        september.PlannedThisMonth.Should().Be(100m);
        september.ContributedThisMonth.Should().Be(100m);
        september.RemainingThisMonth.Should().Be(0m);

        // The current month is today's figures, with October's own line as its plan.
        var october = await ReadAsync(db, October);
        october.CurrentBalance.Should().Be(400m);
        october.BalanceAsOf.Should().Be(Today);
        october.PlannedThisMonth.Should().Be(120m);
        october.ContributedThisMonth.Should().Be(100m);
        october.RemainingThisMonth.Should().Be(20m);

        // Asking for no month at all is the month today falls in — what every other caller gets.
        (await ReadAsync(db, null)).Should().BeEquivalentTo(october);
    }

    [Fact]
    public async Task Rule48_AMonthThatHasNotBegun_ShowsTodaysBalance_WithNothingContributedYet_AndItsOwnPlan()
    {
        await using var db = NewContext();
        SeedHistory(db);

        var november = await ReadAsync(db, November);

        // The future is not read: the balance is today's, dated today — never a projection.
        november.CurrentBalance.Should().Be(400m);
        november.BalanceAsOf.Should().Be(Today);
        // November's line is its plan; nothing has gone in during a month that has not started.
        november.PlannedThisMonth.Should().Be(130m);
        november.ContributedThisMonth.Should().Be(0m);
        november.RemainingThisMonth.Should().Be(130m);
        november.Status.Should().Be("OnTrack");
    }

    [Fact]
    public async Task Rule48_ReadingALaterMonth_DoesNotSettleACycle_WhoseDeadlineHasNotArrived()
    {
        // A Recurring jar held in full with its deadline inside the month being viewed: rule 21's
        // rollover happens when the deadline arrives, not when someone looks ahead at that month.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 11, 15), CycleDeadline = new DateOnly(2026, 11, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 300m, new DateOnly(2026, 8, 1));
        SeedMonth(db, November, bill, 0m);

        var november = await ReadAsync(db, November);

        november.Status.Should().Be("FullyFunded");
        november.Deadline.Should().Be(new DateOnly(2026, 11, 15));
        november.Shortfall.Should().BeNull();
        db.JarCycles.Should().BeEmpty("no cycle closes before its deadline");
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(new DateOnly(2026, 11, 15));
    }

    [Fact]
    public async Task Rule48_APastMonthsStatus_IsWhatItWasAtTheMonthsEnd()
    {
        // 1,200 target held in full at September's end, then 900 spent from the jar in October:
        // September still reads Funded; October reads the plan again.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var jar = SeedGoal(db, account, target: 300m);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 300m, new DateOnly(2026, 8, 20));
        var octoberLine = SeedMonth(db, October, jar, 0m);
        SeedMonth(db, September, jar, 0m);
        LedgerFixtures.Expense(db, Owner, account.Id, 250m, new DateOnly(2026, 10, 3), octoberLine.Id);

        (await ReadAsync(db, September)).Status.Should().Be("FullyFunded");
        (await ReadAsync(db, September)).CurrentBalance.Should().Be(300m);
        (await ReadAsync(db, October)).Status.Should().Be("OnTrack");
        (await ReadAsync(db, October)).CurrentBalance.Should().Be(50m);
    }

    [Fact]
    public async Task Rule49_ACorrectionDatedInAPastMonth_ChangesThatMonth_AndCarriesForward()
    {
        await using var db = NewContext();
        var (account, jar) = SeedHistory(db);
        (await ReadAsync(db, September)).CurrentBalance.Should().Be(300m);

        // A missing September deposit recorded in October, dated when it happened (rule 49's
        // example: September's 300 becomes 350).
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 50m, new DateOnly(2026, 9, 10), JarAllocationKind.Reallocation);

        var september = await ReadAsync(db, September);
        september.CurrentBalance.Should().Be(350m);
        september.ContributedThisMonth.Should().Be(150m);
        // Carried forward: October's balance grew by the same 50; October's own arrivals did not.
        var october = await ReadAsync(db, October);
        october.CurrentBalance.Should().Be(450m);
        october.ContributedThisMonth.Should().Be(100m);
        // August, before the correction's date, is untouched.
        (await ReadAsync(db, new DateOnly(2026, 8, 1))).CurrentBalance.Should().Be(200m);
    }

    [Fact]
    public async Task Rules48And49_TheBudgetGridsAvailable_AgreesWithTheShelf_OnEveryMonth()
    {
        // The grid reads the real clock, so this one runs against it: last month is over, this
        // month is current, next month has not begun. The same history as above, shifted.
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var current = new DateOnly(today.Year, today.Month, 1);
        var previous = current.AddMonths(-1);
        var next = current.AddMonths(1);
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m, openingDate: previous.AddMonths(-2));
        var jar = SeedGoal(db, account);
        jar.TargetDate = next.AddMonths(9);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 200m, previous.AddDays(-10));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, previous.AddDays(14), JarAllocationKind.Reallocation);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, current, JarAllocationKind.Reallocation);
        SeedMonth(db, previous, jar, 100m);
        SeedMonth(db, current, jar, 120m);
        SeedMonth(db, next, jar, 130m);
        // Rule 49: a correction dated in the month that is over.
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 50m, previous.AddDays(9), JarAllocationKind.Reallocation);

        var handler = new GetJarsQueryHandler(db, User());
        foreach (var month in new[] { previous, current, next })
        {
            var shelf = (await handler.Handle(new GetJarsQuery(Month: month), CancellationToken.None)).Single();
            (await GridAvailableAsync(db, month)).Should().Be(shelf.CurrentBalance, $"the shelf and the Available column read one ledger for {month:MMMM}");
        }
        (await GridAvailableAsync(db, previous)).Should().Be(350m);
        (await GridAvailableAsync(db, current)).Should().Be(450m);
    }

    [Fact]
    public async Task Rule55_AGoalCompletedThisMonth_StillReadsAsItWas_InThePastMonth()
    {
        // Completion is dated (rule 55): a goal marked completed on 5 October was live at
        // September's end, so September keeps the status, deadline and horizon it had then and
        // only October reads Completed.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var funded = SeedGoal(db, account, target: 300m);
        var saving = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, funded.Id, 300m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, saving.Id, 200m, new DateOnly(2026, 8, 20), JarAllocationKind.Reallocation);
        SeedMonth(db, September, saving, 100m);
        SeedMonth(db, October, saving, 0m);
        funded.CompletedOn = new DateOnly(2026, 10, 5);
        saving.CompletedOn = new DateOnly(2026, 10, 5);
        db.SaveChanges();

        var handler = new GetJarsQueryHandler(db, User());
        var september = (await handler.Handle(new GetJarsQuery(AsOf: Today, Month: September), CancellationToken.None)).ToDictionary(j => j.Id);
        var october = (await handler.Handle(new GetJarsQuery(AsOf: Today, Month: October), CancellationToken.None)).ToDictionary(j => j.Id);

        september[funded.Id].Status.Should().Be("FullyFunded");
        september[saving.Id].Status.Should().Be("OnTrack");
        september[saving.Id].Deadline.Should().Be(new DateOnly(2027, 7, 1));
        september[saving.Id].FundingCompletesOn.Should().NotBeNull("the plan it had then still frames the month");
        september[saving.Id].PlannedThisMonth.Should().Be(100m);

        october[funded.Id].Status.Should().Be("Completed");
        october[saving.Id].Status.Should().Be("Completed");
        october[saving.Id].FundingCompletesOn.Should().BeNull();
        // The completion itself is a fact of the jar, dated, whichever month is viewed.
        september[saving.Id].CompletedOn.Should().Be(new DateOnly(2026, 10, 5));
    }

    [Fact]
    public async Task Rule80_AJarMovedToAnotherAccount_KeepsTheBalanceItHeld_InThePastMonth()
    {
        // 100 in the jar in account A at August's end, emptied on 10 September and moved to
        // account B (rule 80 allows the change only at zero), 50 put in there on 5 October.
        // August reads the 100 it held in A then; today reads the 50 in B.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, name: "A", opening: 2000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, name: "B", opening: 500m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -100m, new DateOnly(2026, 9, 10), JarAllocationKind.Reallocation);
        jar.FundingAccountId = b.Id;
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, b.Id, jar.Id, 50m, new DateOnly(2026, 10, 5), JarAllocationKind.Reallocation);
        var august = new DateOnly(2026, 8, 1);
        SeedMonth(db, august, jar, 0m);
        SeedMonth(db, September, jar, 0m);
        SeedMonth(db, October, jar, 0m);

        var inAugust = await ReadAsync(db, august);
        inAugust.CurrentBalance.Should().Be(100m, "the money was in A then, and A's ledger still says so");
        inAugust.BalanceAsOf.Should().Be(new DateOnly(2026, 8, 31));
        inAugust.FundingAccountId.Should().Be(b.Id, "the designation is the jar's current one");

        var inSeptember = await ReadAsync(db, September);
        inSeptember.CurrentBalance.Should().Be(0m);
        inSeptember.ContributedThisMonth.Should().Be(0m);

        var inOctober = await ReadAsync(db, October);
        inOctober.CurrentBalance.Should().Be(50m);
        inOctober.ContributedThisMonth.Should().Be(50m);

        // The grid's Available reads the same ledger, so August agrees.
        (await GridAvailableAsync(db, august)).Should().Be(100m);
    }

    [Fact]
    public async Task Rule67_APastMonthBeforeTheAccountOpened_ReadsUnavailable()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 1000m, openingDate: October);
        var jar = SeedGoal(db, account);
        SeedMonth(db, September, jar, 100m);

        var september = await ReadAsync(db, September);

        september.CurrentBalance.Should().BeNull();
        september.Status.Should().Be("Unavailable");
        september.PlannedThisMonth.Should().Be(0m);
    }
}
