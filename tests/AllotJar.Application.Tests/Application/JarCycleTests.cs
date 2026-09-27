using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.DismissJarCycle;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarPayments;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// W03 — a Recurring jar's cycle lifecycle against the confirmed examples in AGREED-RULES
/// (19–24, 57, 83): a funded cycle rolls forward on its own once its deadline arrives, a short
/// one stays as Deadline missed until the user marks it paid (choosing the payment) or dismisses
/// it, leftover money carries into the next cycle, and no step ever moves money or records a
/// payment. Handlers use today's UTC date, so every scenario is built relative to it.
/// </summary>
public class JarCycleTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly MonthStart = new(Today.Year, Today.Month, 1);
    private static readonly DateOnly NextMonth = MonthStart.AddMonths(1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-cycles-{Guid.NewGuid()}")
            .Options);

    private static CurrentUserStub User(string id = Owner) => new(id);

    /// <summary>A yearly Recurring jar whose open cycle is due on <paramref name="due"/>.</summary>
    private static Jar SeedInsurance(ApplicationDbContext db, Account account, DateOnly due, decimal target = 600m, int recurMonths = 12, DateOnly? anchor = null)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = target,
            TargetDate = anchor ?? due, CycleDeadline = due, Accrual = AccrualMethod.TargetByDate,
            RecurMonths = recurMonths, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A budget month with a Savings line for the jar, so a payment can draw from it (rule 79).</summary>
    private static BudgetItem SeedJarLine(ApplicationDbContext db, Jar jar, DateOnly month, decimal planned = 0m)
    {
        var line = new BudgetItem { Name = jar.Name, SavingsId = jar.Id, PlannedAmount = planned };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 3000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    private static Task<IReadOnlyList<JarDto>> ListAsync(ApplicationDbContext db, DateOnly? asOf = null) =>
        new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(AsOf: asOf), CancellationToken.None);

    private static Task<JarDto> MarkPaidAsync(ApplicationDbContext db, Jar jar, DateOnly deadline, Transaction payment, string user = Owner) =>
        new MarkJarCyclePaidCommandHandler(db, User(user)).Handle(new MarkJarCyclePaidCommand(jar.Id, deadline, payment.Id), CancellationToken.None);

    private static Task<JarDto> DismissAsync(ApplicationDbContext db, Jar jar, DateOnly deadline) =>
        new DismissJarCycleCommandHandler(db, User()).Handle(new DismissJarCycleCommand(jar.Id, deadline), CancellationToken.None);

    private static decimal LineFor(ApplicationDbContext db, Jar jar, DateOnly month) => db.BudgetItems
        .Where(i => i.SavingsId == jar.Id && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month)
        .Select(i => i.PlannedAmount)
        .Single();

    // ---- Rule 21: a funded cycle rolls forward on its own -----------------------------

    [Fact]
    public async Task Rule21_ACycleHeldInFull_WhenItsDeadlineArrives_RollsForward_AndMovesNoMoney()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-30));

        var dto = (await ListAsync(db)).Single();

        // The jar now saves toward next year's deadline; its 600 is still there (the user
        // records the actual payment when it happens).
        dto.Status.Should().Be("FullyFunded");
        dto.Shortfall.Should().BeNull();
        dto.Deadline.Should().Be(Today.AddMonths(12));
        dto.CurrentBalance.Should().Be(600m);
        dto.TargetDate.Should().Be(Today); // the anchor is not rewritten
        dto.LastCycle.Should().NotBeNull();
        dto.LastCycle!.Outcome.Should().Be("Funded");
        dto.LastCycle.Deadline.Should().Be(Today);
        dto.LastCycle.BalanceAtDeadline.Should().Be(600m);
        dto.LastCycle.ClosedOn.Should().Be(Today);
        dto.LastCycle.PaymentTransactionId.Should().BeNull();
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(Today.AddMonths(12));
        (await db.JarCycles.CountAsync()).Should().Be(1);
        (await db.JarAllocations.CountAsync()).Should().Be(1);
        (await db.Transactions.CountAsync()).Should().Be(0);

        // Settled once: a second read changes nothing.
        (await ListAsync(db)).Single().LastCycle!.Id.Should().Be(dto.LastCycle.Id);
        (await db.JarCycles.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task Rule21_TheRolloverCountsWhatWasHeldTheDayBefore_NotMoneyThatArrivedOnTheDeadline()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, Today.AddDays(-30));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 150m, Today); // the deadline day itself (rule 82)

        var dto = (await ListAsync(db)).Single();

        // 450 when the money had to be there: the cycle is missed, however full the jar is today
        // (rule 57's Funded late), and nothing rolls.
        dto.Status.Should().Be("FundedLate");
        dto.Deadline.Should().Be(Today);
        (await db.JarCycles.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Rule21_SeveralFundedCyclesPassedUnseen_EachRollsForward_InOrder()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m, openingDate: Today.AddYears(-3));
        // Quarterly jar whose last three deadlines all passed with the target held.
        var jar = SeedInsurance(db, account, due: Today.AddMonths(-6), target: 300m, recurMonths: 3);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 300m, Today.AddMonths(-7));

        var dto = (await ListAsync(db)).Single();

        var cycles = await db.JarCycles.OrderBy(c => c.Deadline).ToListAsync();
        cycles.Select(c => c.Deadline).Should().Equal(Today.AddMonths(-6), Today.AddMonths(-3), Today);
        cycles.Should().OnlyContain(c => c.Outcome == JarCycleOutcome.Funded && c.BalanceAtDeadline == 300m);
        dto.Deadline.Should().Be(Today.AddMonths(3));
        dto.LastCycle!.Deadline.Should().Be(Today);
    }

    // ---- Rule 20: a missed cycle stays until the user acts -------------------------------

    [Fact]
    public async Task Rule20_ACycleShortAtItsDeadline_ReadsDeadlineMissed_WithTheShortfall_AndStaysThatWay()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, Today.AddDays(-30));

        var dto = (await ListAsync(db)).Single();

        dto.Status.Should().Be("DeadlineMissed");
        dto.Shortfall.Should().Be(150m);
        dto.Deadline.Should().Be(Today);
        // The shortfall stays visible as this month's plan, in full (rule 20: highlighted).
        dto.PlannedThisMonth.Should().Be(150m);
        dto.LastCycle.Should().BeNull();
        (await db.JarCycles.CountAsync()).Should().Be(0);

        // Time passes; nothing changes until the user acts.
        var later = (await ListAsync(db, Today.AddMonths(2))).Single();
        later.Status.Should().Be("DeadlineMissed");
        later.Deadline.Should().Be(Today);
        (await db.JarCycles.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Rule20_Dismissing_ResumesSavingTowardTheNextDeadline_FromWhatIsHeld_AndMovesNoMoney()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, Today.AddDays(-30));
        SeedJarLine(db, jar, MonthStart, planned: 150m);
        SeedJarLine(db, jar, NextMonth, planned: 0m);

        var dto = await DismissAsync(db, jar, Today);

        dto.Status.Should().Be("OnTrack");
        dto.Shortfall.Should().BeNull();
        dto.Deadline.Should().Be(Today.AddMonths(12));
        dto.CurrentBalance.Should().Be(450m); // rule 19: the 450 carries; nothing was manufactured or paid
        dto.LastCycle!.Outcome.Should().Be("Missed");
        dto.LastCycle.BalanceAtDeadline.Should().Be(450m);
        dto.LastCycle.ClosedOn.Should().Be(Today);
        dto.LastCycle.PaymentTransactionId.Should().BeNull();
        (await db.Transactions.CountAsync()).Should().Be(0);
        (await db.JarAllocations.CountAsync()).Should().Be(1);

        // The next cycle needs the other 150 (rule 19), spread over the twelve months to the new
        // deadline (rule 46's replant): 12.50 this month and next.
        LineFor(db, jar, MonthStart).Should().Be(12.50m);
        LineFor(db, jar, NextMonth).Should().Be(12.50m);
        dto.PlannedThisMonth.Should().Be(12.50m);
    }

    [Fact]
    public async Task Rule57_FundedAfterTheDeadline_ReadsFundedLate_AndKeepsTheNoticeUntilDismissed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today.AddDays(-7));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, Today.AddDays(-30));
        (await ListAsync(db)).Single().Status.Should().Be("DeadlineMissed");

        // Another 150 a week later: funded, but late — the cycle is not rewritten as met.
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 150m, Today);
        var late = (await ListAsync(db)).Single();
        late.Status.Should().Be("FundedLate");
        late.Shortfall.Should().Be(0m);
        late.Deadline.Should().Be(Today.AddDays(-7));
        (await db.JarCycles.CountAsync()).Should().Be(0);

        var dismissed = await DismissAsync(db, jar, Today.AddDays(-7));
        dismissed.LastCycle!.Outcome.Should().Be("FundedLate");
        dismissed.Status.Should().Be("FullyFunded");
        dismissed.Deadline.Should().Be(Today.AddDays(-7).AddMonths(12));
        dismissed.CurrentBalance.Should().Be(600m);
    }

    [Fact]
    public async Task Dismiss_RefusesACycleThatIsNotMissed_OrNotTheOpenOne()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: NextMonth);

        var ahead = await Assert.ThrowsAsync<ValidationException>(() => DismissAsync(db, jar, NextMonth));
        ahead.Errors["Deadline"][0].Should().Contain("has not been missed");
        var wrong = await Assert.ThrowsAsync<ValidationException>(() => DismissAsync(db, jar, Today.AddMonths(-12)));
        wrong.Errors["Deadline"][0].Should().Contain("no missed cycle");
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(NextMonth);
    }

    // ---- Rules 22–24, 83: marking a cycle paid with the chosen payment -------------------

    [Fact]
    public async Task Rule22_PaidBeforeTheDeadline_AndMarkedPaid_CountsAsMetOnTime_EvenAtZeroBalance()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: NextMonth);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-30));
        var line = SeedJarLine(db, jar, MonthStart);
        // The insurance is paid from the jar today, before the deadline; the jar is empty.
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 600m, Today, line.Id);

        var dto = await MarkPaidAsync(db, jar, NextMonth, payment);

        dto.LastCycle!.Outcome.Should().Be("Paid");
        dto.LastCycle.PaidOnTime.Should().BeTrue();
        dto.LastCycle.PaymentTransactionId.Should().Be(payment.Id);
        dto.LastCycle.PaymentPayee.Should().Be("Shop");
        dto.LastCycle.PaidOn.Should().Be(Today);
        dto.LastCycle.PaidAmount.Should().Be(600m);
        dto.LastCycle.TargetAmount.Should().Be(600m);
        dto.LastCycle.ClosedOn.Should().Be(Today);
        // Rule 24: the next cycle keeps the 600 target; empty, it needs the full 600 by next year.
        dto.TargetAmount.Should().Be(600m);
        dto.Deadline.Should().Be(NextMonth.AddMonths(12));
        dto.CurrentBalance.Should().Be(0m);
        dto.Status.Should().Be("OnTrack");
        dto.Shortfall.Should().BeNull();

        // Reaching the old deadline changes nothing: the cycle was completed, not missed.
        var atDeadline = (await ListAsync(db, NextMonth)).Single();
        atDeadline.Status.Should().Be("OnTrack");
        atDeadline.Deadline.Should().Be(NextMonth.AddMonths(12));
        (await db.JarCycles.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task Rule23_ALowerBill_CarriesOnlyTheActualRemainder_IntoTheNextCycle()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: NextMonth);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-30));
        var line = SeedJarLine(db, jar, MonthStart, planned: 0m);
        SeedJarLine(db, jar, NextMonth, planned: 0m);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 550m, Today, line.Id);

        var dto = await MarkPaidAsync(db, jar, NextMonth, payment);

        // 600 saved, 550 paid: 50 carries forward and the next cycle needs another 550 — the
        // unused 50 of the plan is not money and is never credited (rules 23–24).
        dto.CurrentBalance.Should().Be(50m);
        dto.TargetAmount.Should().Be(600m);
        var preview = await new GetJarScheduleQueryHandler(db, User()).Handle(
            new GetJarScheduleQuery(jar.Id, JarKind.Recurring, 600m, dto.Deadline, AccrualMethod.TargetByDate, RecurMonths: 12), CancellationToken.None);
        preview.Remaining.Should().Be(550m);
        preview.Total.Should().Be(550m);
        preview.Deadline.Should().Be(NextMonth.AddMonths(12));
        // The replant spreads that 550 over the thirteen months up to the month before the new
        // deadline (this month included, rule 82): 42.30 each with the remainder last.
        LineFor(db, jar, MonthStart).Should().Be(42.30m);
        LineFor(db, jar, NextMonth).Should().Be(42.30m);
    }

    [Fact]
    public async Task Rule83_AMissedCycle_MarkedPaidWithAnEarlierPayment_IsPaidNotMissed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-30));
        var line = SeedJarLine(db, jar, MonthStart);
        // Paid a week ago but not yet marked: at the deadline the jar is empty, so it reads missed
        // (the app never guesses which payment settled the bill).
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 600m, Today.AddDays(-7), line.Id);
        (await ListAsync(db)).Single().Status.Should().Be("DeadlineMissed");

        var dto = await MarkPaidAsync(db, jar, Today, payment);

        dto.LastCycle!.Outcome.Should().Be("Paid");
        dto.LastCycle.PaidOnTime.Should().BeTrue(); // paid before the deadline (rule 22)
        dto.LastCycle.BalanceAtDeadline.Should().Be(0m);
        dto.Status.Should().Be("OnTrack");
        dto.Deadline.Should().Be(Today.AddMonths(12));
    }

    [Fact]
    public async Task Rule83_APaymentCanBeLinkedToTheLastCycle_AfterItRolledForwardFunded()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: Today.AddDays(-3));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-30));
        var line = SeedJarLine(db, jar, MonthStart);
        // Read after the deadline: funded, rolled forward. The bill is then paid and linked to
        // THAT cycle, not the new one.
        (await ListAsync(db)).Single().LastCycle!.Outcome.Should().Be("Funded");
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 600m, Today, line.Id);

        var dto = await MarkPaidAsync(db, jar, Today.AddDays(-3), payment);

        dto.LastCycle!.Deadline.Should().Be(Today.AddDays(-3));
        dto.LastCycle.Outcome.Should().Be("Paid");
        dto.LastCycle.PaidOnTime.Should().BeFalse(); // paid after that deadline
        dto.LastCycle.PaymentTransactionId.Should().Be(payment.Id);
        dto.Deadline.Should().Be(Today.AddDays(-3).AddMonths(12)); // the open cycle is untouched
        (await db.JarCycles.CountAsync()).Should().Be(1);

        // A payment settles one cycle: linking it again, to the open cycle, is refused.
        var twice = await Assert.ThrowsAsync<ValidationException>(() => MarkPaidAsync(db, jar, dto.Deadline!.Value, payment));
        twice.Errors["PaymentTransactionId"][0].Should().Contain("already fulfilled");
    }

    [Fact]
    public async Task Rule83_MarkPaid_RefusesIncomeTransfersRefunds_UnknownCycles_Goals_AndOtherHouseholds()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, due: NextMonth);
        var income = LedgerFixtures.Income(db, Owner, account.Id, 100m, Today);
        var expense = LedgerFixtures.Expense(db, Owner, account.Id, 100m, Today);
        var refund = LedgerFixtures.Income(db, Owner, account.Id, 20m, Today);
        refund.RefundOfTransactionId = expense.Id;
        db.SaveChanges();

        (await Assert.ThrowsAsync<ValidationException>(() => MarkPaidAsync(db, jar, NextMonth, income)))
            .Errors["PaymentTransactionId"][0].Should().Contain("money out");
        (await Assert.ThrowsAsync<ValidationException>(() => MarkPaidAsync(db, jar, NextMonth, refund)))
            .Errors["PaymentTransactionId"][0].Should().Contain("money out");
        (await Assert.ThrowsAsync<ValidationException>(() => MarkPaidAsync(db, jar, NextMonth.AddMonths(1), expense)))
            .Errors["Deadline"][0].Should().Contain("has no cycle due");
        await Assert.ThrowsAsync<ForbiddenAccessException>(() => MarkPaidAsync(db, jar, NextMonth, expense, user: "someone-else"));

        var goal = new Jar { OwnerId = Owner, Name = "Sofa", Kind = JarKind.Goal, TargetAmount = 500m, TargetDate = NextMonth, FundingAccountId = account.Id };
        db.Jars.Add(goal);
        db.SaveChanges();
        (await Assert.ThrowsAsync<ValidationException>(() => MarkPaidAsync(db, goal, NextMonth, expense)))
            .Errors["Deadline"][0].Should().Contain("goal");

        (await db.JarCycles.CountAsync()).Should().Be(0);
        (await db.Jars.SingleAsync(j => j.Id == jar.Id)).CycleDeadline.Should().Be(NextMonth);
    }

    [Fact]
    public async Task Rule62_ClosedCycles_StepFromTheAnchor_SoAMonthEndDeadlineKeepsItsDay()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        // Monthly, anchored on the 31st; the open cycle is this month's clamped occurrence.
        var anchor = new DateOnly(2026, 1, 31);
        var open = JarSchedule.NextCycleDeadline(new Jar { TargetDate = anchor, RecurMonths = 1 }, Today)!.Value;
        var jar = SeedInsurance(db, account, due: open, target: 100m, recurMonths: 1, anchor: anchor);
        var line = SeedJarLine(db, jar, MonthStart);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 10m, Today, line.Id);

        var dto = await MarkPaidAsync(db, jar, open, payment);

        var expected = JarSchedule.NextCycleDeadline(jar, open)!.Value;
        dto.Deadline.Should().Be(expected);
        expected.Day.Should().Be(Math.Min(31, DateTime.DaysInMonth(expected.Year, expected.Month)));
        dto.TargetDate.Should().Be(anchor);
    }

    // ---- Edits and the open cycle ------------------------------------------------------

    [Fact]
    public async Task Update_EchoingTheOpenCyclesDate_KeepsTheCycle_AndANewDateRestartsIt()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var anchor = Today.AddMonths(-12);
        var jar = SeedInsurance(db, account, due: NextMonth, anchor: anchor);
        var handler = new UpdateJarCommandHandler(db, User());

        // The form shows the open cycle's date; a rename sends it back unchanged.
        var renamed = await handler.Handle(new UpdateJarCommand(
            jar.Id, "Car insurance", JarKind.Recurring, 600m, NextMonth, AccrualMethod.TargetByDate, account.Id, RecurMonths: 12), CancellationToken.None);
        renamed.Deadline.Should().Be(NextMonth);
        renamed.TargetDate.Should().Be(anchor);

        // A different date is a deliberate change: it is the new anchor and the new open cycle.
        var moved = await handler.Handle(new UpdateJarCommand(
            jar.Id, "Car insurance", JarKind.Recurring, 600m, NextMonth.AddMonths(2), AccrualMethod.TargetByDate, account.Id, RecurMonths: 12), CancellationToken.None);
        moved.Deadline.Should().Be(NextMonth.AddMonths(2));
        moved.TargetDate.Should().Be(NextMonth.AddMonths(2));
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(NextMonth.AddMonths(2));
    }

    [Fact]
    public async Task ThePreviewOfAnEdit_PlansTowardTheOpenCycle_WhenTheDateIsEchoed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var anchor = Today.AddMonths(-12);
        var jar = SeedInsurance(db, account, due: NextMonth, anchor: anchor);

        var preview = await new GetJarScheduleQueryHandler(db, User()).Handle(
            new GetJarScheduleQuery(jar.Id, JarKind.Recurring, 600m, NextMonth, AccrualMethod.TargetByDate, RecurMonths: 12), CancellationToken.None);

        preview.Deadline.Should().Be(NextMonth);
        preview.Months.Should().HaveCount(1); // this month is the last before the deadline
        preview.Total.Should().Be(600m);
    }

    // ---- The payments offered for marking a cycle paid ------------------------------

    [Fact]
    public async Task Payments_ListTheJarsOwnPayments_LeaveOutFulfilledOnes_AndOfferTheRestOnRequest()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var current = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current, order: 1);
        var jar = SeedInsurance(db, account, due: NextMonth);
        var line = SeedJarLine(db, jar, MonthStart);
        var onLine = LedgerFixtures.Expense(db, Owner, account.Id, 600m, Today.AddDays(-2), line.Id);
        var paidFromJar = LedgerFixtures.Expense(db, Owner, account.Id, 40m, Today.AddDays(-1));
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = account.Id, Kind = JarAllocationKind.Movement, TransactionId = paidFromJar.Id, Date = paidFromJar.Date,
            CreatedUtc = DateTime.UtcNow, Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = -40m } },
        });
        var unallocated = LedgerFixtures.Expense(db, Owner, account.Id, 15m, Today.AddDays(-3));
        var elsewhere = LedgerFixtures.Expense(db, Owner, current.Id, 590m, Today);
        var otherHousehold = LedgerFixtures.Expense(db, "someone-else", current.Id, 590m, Today);
        LedgerFixtures.Income(db, Owner, account.Id, 100m, Today);
        var fulfilled = LedgerFixtures.Expense(db, Owner, account.Id, 600m, Today.AddMonths(-11), line.Id);
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = jar.Id, Deadline = NextMonth.AddMonths(-12), TargetAmount = 600m, Outcome = JarCycleOutcome.Paid,
            PaymentTransactionId = fulfilled.Id, PaidOn = fulfilled.Date, PaidAmount = 600m, ClosedOn = fulfilled.Date, CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
        var handler = new GetJarPaymentsQueryHandler(db, User());

        var own = await handler.Handle(new GetJarPaymentsQuery(jar.Id), CancellationToken.None);
        own.Select(p => p.Id).Should().Equal(paidFromJar.Id, onLine.Id); // newest first; the jar's own payments only
        own.Should().OnlyContain(p => p.FromJar && p.AccountName == "Savings");
        own.Single(p => p.Id == onLine.Id).BudgetItemName.Should().Be("Insurance");

        var all = await handler.Handle(new GetJarPaymentsQuery(jar.Id, IncludeOtherPayments: true), CancellationToken.None);
        all.Select(p => p.Id).Should().Equal(elsewhere.Id, paidFromJar.Id, onLine.Id, unallocated.Id);
        all.Single(p => p.Id == elsewhere.Id).FromJar.Should().BeFalse();
        all.Select(p => p.Id).Should().NotContain(new[] { fulfilled.Id, otherHousehold.Id });

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            new GetJarPaymentsQueryHandler(db, User("someone-else")).Handle(new GetJarPaymentsQuery(jar.Id), CancellationToken.None));
    }
}
