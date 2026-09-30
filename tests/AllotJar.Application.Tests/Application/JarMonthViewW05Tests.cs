using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.UpdateJar;
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

    // A fixed "today" so the maths are deterministic: October is the current month, September
    // is over and November has not begun.
    private static readonly DateOnly Today = new(2026, 10, 10);
    private static readonly DateOnly September = new(2026, 9, 1);
    private static readonly DateOnly October = new(2026, 10, 1);
    private static readonly DateOnly November = new(2026, 11, 1);

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

    private static BudgetItem SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar, decimal planned) =>
        SeedMonth(db, month, (jar, planned)).Single();

    /// <summary>A budget month with a Savings line per jar given (none, for a month with no jar lines).</summary>
    private static IReadOnlyList<BudgetItem> SeedMonth(ApplicationDbContext db, DateOnly month, params (Jar Jar, decimal Planned)[] lines)
    {
        var items = lines.Select(l => new BudgetItem { Name = l.Jar.Name, PlannedAmount = l.Planned, SavingsId = l.Jar.Id }).ToList();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = items },
            },
        });
        db.SaveChanges();
        return items;
    }

    /// <summary>The jar's figures for <paramref name="month"/> as the Budget page's shelf asks for them (today injected).</summary>
    private static async Task<JarDto> ReadAsync(ApplicationDbContext db, DateOnly? month) =>
        (await new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(AsOf: Today, Month: month), CancellationToken.None)).Single();

    private static async Task<IReadOnlyList<JarDto>> ReadAllAsync(ApplicationDbContext db, DateOnly? month) =>
        await new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(AsOf: Today, Month: month), CancellationToken.None);

    private static async Task<decimal?> GridAvailableAsync(ApplicationDbContext db, DateOnly month, Guid? jarId = null) =>
        (await new GetBudgetMonthQueryHandler(db, User()).Handle(new GetBudgetMonthQuery(month.Year, month.Month), CancellationToken.None))
        .Categories.Single(c => c.Kind == "Savings").Items.Single(i => jarId is null || i.SavingsId == jarId).SavingsAvailable;

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
        // A 300 target held in full at September's end, then 250 spent from the jar in October:
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
    public async Task Rule80_AJarMovedToAnAccountOpenedLater_StillReadsWhatTheOldAccountHeld_ForTheEarlierMonth()
    {
        // As above, but B only opened on 1 October: August is before B existed, and the jar's
        // money that month was in A, whose ledger was open. July, before the jar's first posting in
        // A, reads the 0 A held then (P2-15). Only a month before any account held the jar reads
        // unavailable (rule 67).
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, name: "A", opening: 2000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, name: "B", opening: 500m, order: 1, openingDate: October);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -100m, new DateOnly(2026, 9, 10), JarAllocationKind.Reallocation);
        jar.FundingAccountId = b.Id;
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, b.Id, jar.Id, 50m, new DateOnly(2026, 10, 5), JarAllocationKind.Reallocation);
        var august = new DateOnly(2026, 8, 1);
        SeedMonth(db, august, jar, 0m);

        var inAugust = await ReadAsync(db, august);
        inAugust.CurrentBalance.Should().Be(100m, "A's ledger held it then and A was open; B's opening date is irrelevant to August");
        inAugust.Status.Should().NotBe("Unavailable");
        (await GridAvailableAsync(db, august)).Should().Be(100m);
        (await ReadAsync(db, October)).CurrentBalance.Should().Be(50m);

        var july = new DateOnly(2026, 7, 1);
        SeedMonth(db, july, jar, 0m);
        var inJuly = await ReadAsync(db, july);
        inJuly.CurrentBalance.Should().Be(0m);
        inJuly.Status.Should().NotBe("Unavailable");
        (await GridAvailableAsync(db, july)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, new DateOnly(2025, 12, 31), CancellationToken.None)).BalanceOf(jar.Id).Should().BeNull();
    }

    [Fact]
    public async Task Rule46_AMonthThatIsOver_WithNoLineForTheJar_PlansNothingForIt()
    {
        // A jar created in October never had a September line (lines are planted from the
        // current month on): September's shelf shows no plan for it, rather than one computed
        // after the fact beside a grid that has no such line.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var other = new Jar
        {
            OwnerId = Owner, Name = "Other", Kind = JarKind.Goal, TargetAmount = 600m, TargetDate = new DateOnly(2027, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(other);
        db.SaveChanges();
        var jar = SeedGoal(db, account);
        SeedMonth(db, September, (other, 10m));
        SeedMonth(db, October, (other, 10m), (jar, 120m));

        var september = (await ReadAllAsync(db, September)).Single(j => j.Id == jar.Id);
        september.PlannedThisMonth.Should().Be(0m);
        september.RemainingThisMonth.Should().Be(0m);
        // The current month keeps its line, and a month that has not begun with no line yet is
        // planned from that month: 1,200 over the eight months November–June is 150 each.
        (await ReadAllAsync(db, October)).Single(j => j.Id == jar.Id).PlannedThisMonth.Should().Be(120m);
        (await ReadAllAsync(db, November)).Single(j => j.Id == jar.Id).PlannedThisMonth.Should().Be(150m);
    }

    [Fact]
    public async Task Rule27_AMonthThatIsOver_StillListsAJarArchivedSince_WhoseLineItCarries()
    {
        // 300 held at September's end; emptied and archived on 2 October. September's Savings
        // line still shows 300 available, so September's shelf still shows the jar.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var jar = SeedGoal(db, account, target: 300m);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 300m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, -300m, new DateOnly(2026, 10, 2), JarAllocationKind.Reallocation);
        jar.IsArchived = true;
        db.SaveChanges();
        SeedMonth(db, September, jar, 0m);
        SeedMonth(db, October);

        (await GridAvailableAsync(db, September)).Should().Be(300m);
        var september = (await ReadAllAsync(db, September)).Should().ContainSingle(j => j.Id == jar.Id).Subject;
        september.CurrentBalance.Should().Be(300m);
        september.IsArchived.Should().BeTrue();
        // Today the jar is archived and out of the way, as before.
        (await ReadAllAsync(db, October)).Should().BeEmpty();
        (await ReadAllAsync(db, null)).Should().BeEmpty();
    }

    [Fact]
    public async Task Rule20_AMonthThatIsOver_IsJudgedAgainstTheCycleOpenThen_NotTodays()
    {
        // Recurring 300 due 15 September with only 100 held: at September's end the card read
        // Deadline missed with a 200 shortfall. On 3 October the user marked the cycle paid
        // (closing it; the next deadline is 15 September 2027). September still reads what it
        // read then (P49); October reads the new cycle.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2027, 9, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 8, 1));
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = bill.Id, Deadline = new DateOnly(2026, 9, 15), TargetAmount = 300m,
            Outcome = JarCycleOutcome.Paid, BalanceAtDeadline = 100m, PaidOn = new DateOnly(2026, 10, 3), PaidAmount = 300m,
            ClosedOn = new DateOnly(2026, 10, 3), CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
        SeedMonth(db, September, bill, 0m);
        SeedMonth(db, October, bill, 0m);

        var september = await ReadAsync(db, September);
        september.Status.Should().Be("DeadlineMissed");
        september.Deadline.Should().Be(new DateOnly(2026, 9, 15));
        september.Shortfall.Should().Be(200m);
        september.LastCycle.Should().BeNull("no cycle had closed by September's end");

        var october = await ReadAsync(db, October);
        october.Status.Should().Be("OnTrack");
        october.Deadline.Should().Be(new DateOnly(2027, 9, 15));
        october.Shortfall.Should().BeNull();
        october.LastCycle!.Outcome.Should().Be("Paid");
    }

    /// <summary>Edits the jar's definition on <paramref name="on"/> as UpdateJar does: the revision history first, then the row.</summary>
    private static async Task EditAsync(ApplicationDbContext db, Jar jar, DateOnly on, Action<Jar> edit)
    {
        var replaced = JarRevision.Of(jar, on);
        edit(jar);
        await JarHistory.RecordEditAsync(db, jar, replaced, on, CancellationToken.None);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Rule46_ATargetChangedAfterAMonthEnded_LeavesThatMonthJudgedAgainstTheTargetItHad()
    {
        // P2-8's first example, both ways. Holiday: 300 due 1 July 2027, held in full since
        // 20 August (Funded at September's end); on 5 October the target goes to 600. Sofa: 600
        // due the same day, 300 held (half full at September's end); on 5 October lowered to 300.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var holiday = SeedGoal(db, account, target: 300m);
        var sofa = SeedGoal(db, account, target: 600m);
        sofa.Name = "Sofa";
        LedgerFixtures.Allocate(db, Owner, account.Id, holiday.Id, 300m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, sofa.Id, 300m, new DateOnly(2026, 8, 20), JarAllocationKind.Reallocation);
        SeedMonth(db, September, (holiday, 0m), (sofa, 30m));
        SeedMonth(db, October, (holiday, 0m), (sofa, 30m));
        await EditAsync(db, holiday, new DateOnly(2026, 10, 5), j => j.TargetAmount = 600m);
        await EditAsync(db, sofa, new DateOnly(2026, 10, 5), j => j.TargetAmount = 300m);

        var september = (await ReadAllAsync(db, September)).ToDictionary(j => j.Id);
        september[holiday.Id].Status.Should().Be("FullyFunded");
        september[holiday.Id].TargetAmount.Should().Be(300m, "the shelf draws the jar full against the target it had");
        september[holiday.Id].CurrentBalance.Should().Be(300m);
        september[sofa.Id].Status.Should().Be("OnTrack");
        september[sofa.Id].TargetAmount.Should().Be(600m);

        var october = (await ReadAllAsync(db, October)).ToDictionary(j => j.Id);
        october[holiday.Id].Status.Should().Be("OnTrack");
        october[holiday.Id].TargetAmount.Should().Be(600m);
        october[sofa.Id].Status.Should().Be("FullyFunded");
        october[sofa.Id].TargetAmount.Should().Be(300m);
    }

    [Fact]
    public async Task Rule46_ADeadlineOrKindChangedAfterAMonthEnded_LeavesThatMonthBehind()
    {
        // P2-8's second example: Holiday, 300 due 15 September with 100 held — Behind at
        // September's end, 200 short. On 5 October its date moves to 1 July 2027. Deposit, the
        // same goal, becomes a yearly Recurring jar due 15 September 2027 on 5 October. September
        // still reads Behind for both (a goal past its date, never Deadline missed); October reads
        // On track.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var holiday = SeedGoal(db, account, target: 300m);
        var deposit = SeedGoal(db, account, target: 300m);
        deposit.Name = "Deposit";
        holiday.TargetDate = deposit.TargetDate = new DateOnly(2026, 9, 15);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, holiday.Id, 100m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, deposit.Id, 100m, new DateOnly(2026, 8, 20), JarAllocationKind.Reallocation);
        SeedMonth(db, September, (holiday, 200m), (deposit, 200m));
        SeedMonth(db, October, (holiday, 0m), (deposit, 0m));
        await EditAsync(db, holiday, new DateOnly(2026, 10, 5), j => j.TargetDate = new DateOnly(2027, 7, 1));
        await EditAsync(db, deposit, new DateOnly(2026, 10, 5), j =>
        {
            j.Kind = JarKind.Recurring;
            j.RecurMonths = 12;
            j.TargetDate = j.CycleDeadline = new DateOnly(2027, 9, 15);
        });

        var september = (await ReadAllAsync(db, September)).ToDictionary(j => j.Id);
        september[holiday.Id].Status.Should().Be("Behind");
        september[holiday.Id].Deadline.Should().Be(new DateOnly(2026, 9, 15));
        september[holiday.Id].TargetAmount.Should().Be(300m);
        september[deposit.Id].Status.Should().Be("Behind");
        september[deposit.Id].Kind.Should().Be(JarKind.Goal, "a month that is over shows the definition it was judged against");
        september[deposit.Id].Shortfall.Should().BeNull();

        var october = (await ReadAllAsync(db, October)).ToDictionary(j => j.Id);
        october[holiday.Id].Status.Should().Be("OnTrack");
        october[holiday.Id].Deadline.Should().Be(new DateOnly(2027, 7, 1));
        october[deposit.Id].Status.Should().Be("OnTrack");
        october[deposit.Id].Kind.Should().Be(JarKind.Recurring);
    }

    [Fact]
    public async Task Rule20_ARecurringDateChangedAfterAMissedMonth_LeavesThatMonthDeadlineMissed()
    {
        // Recurring 300 due 15 September, 100 held: Deadline missed at September's end, 200 short.
        // On 5 October the user moves the date to 15 September 2027 instead of marking the cycle
        // paid or dismissing it — no cycle closes. September still reads what it read then.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2026, 9, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 8, 1));
        SeedMonth(db, September, bill, 0m);
        SeedMonth(db, October, bill, 0m);
        await EditAsync(db, bill, new DateOnly(2026, 10, 5), j =>
        {
            j.TargetDate = new DateOnly(2027, 9, 15);
            j.CycleDeadline = new DateOnly(2027, 9, 15);
        });

        var september = await ReadAsync(db, September);
        september.Status.Should().Be("DeadlineMissed");
        september.Deadline.Should().Be(new DateOnly(2026, 9, 15));
        september.Shortfall.Should().Be(200m);

        var october = await ReadAsync(db, October);
        october.Status.Should().Be("OnTrack");
        october.Deadline.Should().Be(new DateOnly(2027, 9, 15));
        october.Shortfall.Should().BeNull();
    }

    [Fact]
    public async Task Rule21_ACycleThatRolledForwardBeforeTheMonthEnded_IsNotReadAsMissed_WhenSettledLater()
    {
        // Monthly bill, 100 due on the 15th, target set to 100 on 1 September (so the jar has a
        // revision naming the 15 September cycle). The 15 September cycle closed Funded, recorded
        // on its deadline although settled in October; on 5 October the target went to 120.
        // September's end was on the 15 October cycle with 100 held: Funded, not Funded late.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Phone", Kind = JarKind.Recurring, TargetAmount = 80m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2026, 9, 15), RecurMonths = 1,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        await EditAsync(db, bill, new DateOnly(2026, 9, 1), j => j.TargetAmount = 100m);
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 8, 20));
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = bill.Id, Deadline = new DateOnly(2026, 9, 15), TargetAmount = 100m,
            Outcome = JarCycleOutcome.Funded, BalanceAtDeadline = 100m, ClosedOn = new DateOnly(2026, 9, 15), CreatedUtc = DateTime.UtcNow,
        });
        bill.CycleDeadline = new DateOnly(2026, 10, 15);
        db.SaveChanges();
        SeedMonth(db, September, bill, 20m);
        SeedMonth(db, October, bill, 20m);
        await EditAsync(db, bill, new DateOnly(2026, 10, 5), j => j.TargetAmount = 120m);

        var september = await ReadAsync(db, September);
        september.Status.Should().Be("FullyFunded");
        september.Deadline.Should().Be(new DateOnly(2026, 10, 15));
        september.TargetAmount.Should().Be(100m);
        september.Shortfall.Should().BeNull();

        var october = await ReadAsync(db, October);
        october.TargetAmount.Should().Be(120m);
        october.Status.Should().Be("OnTrack");
    }

    [Fact]
    public async Task Rule46_ARecurringTargetRaisedAfterTheMonth_StaysThatMonthsTarget_WhenTheCycleCloses()
    {
        // Yearly bill, 300 due 15 September, 300 held since 20 August: Funded at August's end. On
        // 5 September the target goes to 600 (the date echoed, so the cycle stays); on 20 September
        // the cycle is marked paid, recording the 600 it closed with. August still reads Funded
        // against 300 — the cycle's record does not rewrite the month; September reads the next
        // cycle against 600.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2026, 9, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 300m, new DateOnly(2026, 8, 20));
        var august = new DateOnly(2026, 8, 1);
        SeedMonth(db, august, bill, 0m);
        SeedMonth(db, September, bill, 0m);
        await EditAsync(db, bill, new DateOnly(2026, 9, 5), j => j.TargetAmount = 600m);
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = bill.Id, Deadline = new DateOnly(2026, 9, 15), TargetAmount = 600m,
            Outcome = JarCycleOutcome.Paid, BalanceAtDeadline = 300m, PaidOn = new DateOnly(2026, 9, 10), PaidAmount = 580m,
            ClosedOn = new DateOnly(2026, 9, 20), CreatedUtc = DateTime.UtcNow,
        });
        bill.CycleDeadline = new DateOnly(2027, 9, 15);
        db.SaveChanges();

        var inAugust = await ReadAsync(db, august);
        inAugust.Status.Should().Be("FullyFunded");
        inAugust.TargetAmount.Should().Be(300m);
        inAugust.Deadline.Should().Be(new DateOnly(2026, 9, 15));

        var inSeptember = await ReadAsync(db, September);
        inSeptember.Status.Should().Be("OnTrack");
        inSeptember.TargetAmount.Should().Be(600m);
        inSeptember.Deadline.Should().Be(new DateOnly(2027, 9, 15));
    }

    [Fact]
    public async Task Rule20_APastMonthsTargetAmount_IsTheTargetItsStatusUsed()
    {
        // P3-4: the missed 15 September cycle (300, 100 held) was marked paid on 3 October and the
        // target then raised to 600. September's shortfall is against 300, and so is the target it
        // returns (the shelf's fill is balance ÷ targetAmount: a third, not a sixth).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2027, 9, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 8, 1));
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = bill.Id, Deadline = new DateOnly(2026, 9, 15), TargetAmount = 300m,
            Outcome = JarCycleOutcome.Paid, BalanceAtDeadline = 100m, PaidOn = new DateOnly(2026, 10, 3), PaidAmount = 300m,
            ClosedOn = new DateOnly(2026, 10, 3), CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
        SeedMonth(db, September, bill, 0m);
        await EditAsync(db, bill, new DateOnly(2026, 10, 4), j => j.TargetAmount = 600m);

        var september = await ReadAsync(db, September);
        september.Status.Should().Be("DeadlineMissed");
        september.Shortfall.Should().Be(200m);
        september.TargetAmount.Should().Be(300m);
    }

    [Fact]
    public async Task Rule46_UpdateJar_RecordsTheDefinitionItReplaces_OnePerDay_AndLastMonthKeepsIt()
    {
        // Against the real clock (the handler has no injectable today): a jar never edited has no
        // history; its first edit records the definition it replaces (from the beginning) and the
        // new one (from today); a second edit today overwrites today's; a rename records nothing.
        // Last month then still reads the target it had; this month reads today's.
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var current = new DateOnly(today.Year, today.Month, 1);
        var previous = current.AddMonths(-1);
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m, openingDate: previous.AddMonths(-2));
        var jar = SeedGoal(db, account, target: 300m);
        jar.TargetDate = current.AddMonths(10);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 300m, previous.AddDays(-5));
        SeedMonth(db, previous, jar, 0m);
        SeedMonth(db, current, jar, 0m);
        var handler = new UpdateJarCommandHandler(db, User());
        UpdateJarCommand Edit(string name, decimal target) =>
            new(jar.Id, name, JarKind.Goal, target, current.AddMonths(10), AccrualMethod.TargetByDate, account.Id);

        await handler.Handle(Edit("Holiday", 600m), CancellationToken.None);
        await handler.Handle(Edit("Holiday", 700m), CancellationToken.None);
        await handler.Handle(Edit("Summer holiday", 700m), CancellationToken.None);

        var history = await db.JarRevisions.Where(r => r.JarId == jar.Id).OrderBy(r => r.EffectiveFrom).ToListAsync();
        history.Select(r => (r.EffectiveFrom, r.TargetAmount)).Should().Equal((DateOnly.MinValue, 300m), (today, 700m));

        var reads = new GetJarsQueryHandler(db, User());
        var last = (await reads.Handle(new GetJarsQuery(Month: previous), CancellationToken.None)).Single();
        last.TargetAmount.Should().Be(300m);
        last.Status.Should().Be("FullyFunded");
        var now = (await reads.Handle(new GetJarsQuery(Month: current), CancellationToken.None)).Single();
        now.TargetAmount.Should().Be(700m);
        now.Status.Should().Be("OnTrack");
    }

    [Fact]
    public async Task Rule27_AJarArchivedAfterAMonthItMissed_StillReadsDeadlineMissedThere()
    {
        // Recurring 300 due 15 September with 100 held: September ended Deadline missed, 200 short.
        // On 2 October the bill is cancelled: the 100 goes back and the jar is archived. September
        // still reads what it read then; a jar archived before a month ended reads archived there.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 9, 15), CycleDeadline = new DateOnly(2026, 9, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 8, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, -100m, new DateOnly(2026, 10, 2), JarAllocationKind.Reallocation);
        SeedMonth(db, September, bill, 0m);
        SeedMonth(db, October, bill, 0m);
        bill.IsArchived = true;
        bill.ArchivedOn = new DateOnly(2026, 10, 2);
        db.SaveChanges();

        var september = (await ReadAllAsync(db, September)).Should().ContainSingle(j => j.Id == bill.Id).Subject;
        september.Status.Should().Be("DeadlineMissed");
        september.Shortfall.Should().Be(200m);
        september.Deadline.Should().Be(new DateOnly(2026, 9, 15));

        // Archived on 30 September instead: at September's end it was already put away.
        bill.ArchivedOn = new DateOnly(2026, 9, 30);
        db.SaveChanges();
        var archivedThen = (await ReadAllAsync(db, September)).Single(j => j.Id == bill.Id);
        archivedThen.Status.Should().NotBe("DeadlineMissed");
        archivedThen.Shortfall.Should().BeNull();
    }

    [Fact]
    public async Task Rule22_ABillPaidBeforeItsDeadline_ButMarkedPaidLater_ReadsPaidOnTimeOnThePastMonths()
    {
        // Rule 22's example: 600 saved, the bill paid on 28 August from the jar's line, due
        // 1 September; the user marks the cycle paid with that payment only on 5 October. The
        // cycle was complete from the payment: August's history line shows it paid on time and
        // September is judged against the next cycle, never Deadline missed for the full 600.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m,
            TargetDate = new DateOnly(2026, 9, 1), CycleDeadline = new DateOnly(2027, 9, 1), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 600m, new DateOnly(2026, 7, 1));
        var august = SeedMonth(db, new DateOnly(2026, 8, 1), bill, 0m);
        SeedMonth(db, September, bill, 0m);
        SeedMonth(db, October, bill, 0m);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 600m, new DateOnly(2026, 8, 28), august.Id);
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = bill.Id, Deadline = new DateOnly(2026, 9, 1), TargetAmount = 600m,
            Outcome = JarCycleOutcome.Paid, BalanceAtDeadline = 0m, PaymentTransactionId = payment.Id,
            PaidOn = new DateOnly(2026, 8, 28), PaidAmount = 600m, ClosedOn = new DateOnly(2026, 10, 5), CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();

        var augustRead = await ReadAsync(db, new DateOnly(2026, 8, 1));
        augustRead.CurrentBalance.Should().Be(0m);
        augustRead.Status.Should().Be("OnTrack");
        augustRead.Deadline.Should().Be(new DateOnly(2027, 9, 1));
        augustRead.LastCycle!.PaidOnTime.Should().BeTrue();

        var september = await ReadAsync(db, September);
        september.Status.Should().Be("OnTrack");
        september.Shortfall.Should().BeNull();
        september.Deadline.Should().Be(new DateOnly(2027, 9, 1));
        september.LastCycle!.PaidOnTime.Should().BeTrue();
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
