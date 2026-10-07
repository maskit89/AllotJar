using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.DismissJarCycle;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// A date given as just a month (jar setup plan, PR 2): stored as the 1st of the month with
/// <see cref="Jar.MonthOnly"/>, planned exactly as a date on the 1st (rule 12), and read back as
/// "Mar 2027". The flag changes how the date reads and when it counts as passed, never the plan:
/// a month still short when it begins reads Behind while it runs and Deadline missed only from the
/// next (Christopher, 7 October 2026), and a payment within the month is on time.
/// </summary>
public class JarMonthOnlyTests
{
    private const string Owner = "user-1";

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly MonthStart = new(Today.Year, Today.Month, 1);

    private static Task<JarDto> CreateAsync(ApplicationDbContext db, Account account, DateOnly? due, bool monthOnly,
        JarKind kind = JarKind.Goal, AccrualMethod accrual = AccrualMethod.TargetByDate, decimal? monthly = null, string name = "Holiday") =>
        new CreateJarCommandHandler(db, new CurrentUserStub(Owner)).Handle(new CreateJarCommand(
            name, kind, 300m, due, accrual, account.Id,
            RecurMonths: kind == JarKind.Recurring ? 12 : null, MonthlyContribution: monthly, MonthOnly: monthOnly), CancellationToken.None);

    private static Task<JarDto> UpdateAsync(ApplicationDbContext db, Account account, JarDto jar, DateOnly? due, bool? monthOnly,
        AccrualMethod accrual = AccrualMethod.TargetByDate, decimal? monthly = null) =>
        new UpdateJarCommandHandler(db, new CurrentUserStub(Owner)).Handle(new UpdateJarCommand(
            jar.Id, jar.Name, accrual == AccrualMethod.FixedMonthly ? JarKind.Goal : jar.Kind, 300m, due, accrual, account.Id,
            RecurMonths: jar.RecurMonths, MonthlyContribution: monthly, MonthOnly: monthOnly), CancellationToken.None);

    [Fact]
    public async Task Create_JustTheMonth_IsStoredAsTheFirst_AndPlansExactlyAsThatDate()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(3);

        var month = await CreateAsync(db, account, due, monthOnly: true, name: "Holiday");
        var day = await CreateAsync(db, account, due, monthOnly: false, name: "Sofa");

        month.MonthOnly.Should().BeTrue();
        day.MonthOnly.Should().BeFalse();
        // Rule 12: the money is ready when the month begins, so the plan is the 1st's.
        month.PlannedThisMonth.Should().Be(day.PlannedThisMonth).And.Be(100m);
        month.FundingCompletesOn.Should().Be(day.FundingCompletesOn).And.Be(due.AddDays(-1));
        month.Deadline.Should().Be(due);
        (await db.Jars.AsNoTracking().SingleAsync(j => j.Id == month.Id)).MonthOnly.Should().BeTrue();
    }

    [Fact]
    public async Task Create_AFixedMonthlyPlan_HasNoDate_SoItIsNeverMonthOnly()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);

        var pot = await CreateAsync(db, account, null, monthOnly: true, accrual: AccrualMethod.FixedMonthly, monthly: 50m);

        pot.MonthOnly.Should().BeFalse();
        (await db.Jars.AsNoTracking().SingleAsync()).MonthOnly.Should().BeFalse();
    }

    [Fact]
    public void Validators_RefuseJustTheMonth_OnADayOtherThanTheFirst()
    {
        var account = Guid.NewGuid();
        var midMonth = MonthStart.AddMonths(2).AddDays(14);
        const string message = "A date given as just the month must be the 1st of that month.";

        new CreateJarCommandValidator().Validate(new CreateJarCommand(
            "Holiday", JarKind.Goal, 300m, midMonth, AccrualMethod.TargetByDate, account, MonthOnly: true)).Errors
            .Should().ContainSingle(e => e.ErrorMessage == message);
        new CreateJarCommandValidator().Validate(new CreateJarCommand(
            "Holiday", JarKind.Goal, 300m, MonthStart.AddMonths(2), AccrualMethod.TargetByDate, account, MonthOnly: true))
            .IsValid.Should().BeTrue();
        // A full date may fall on any day.
        new CreateJarCommandValidator().Validate(new CreateJarCommand(
            "Holiday", JarKind.Goal, 300m, midMonth, AccrualMethod.TargetByDate, account))
            .IsValid.Should().BeTrue();

        new UpdateJarCommandValidator().Validate(new UpdateJarCommand(
            Guid.NewGuid(), "Holiday", JarKind.Goal, 300m, midMonth, AccrualMethod.TargetByDate, account, MonthOnly: true)).Errors
            .Should().ContainSingle(e => e.ErrorMessage == message);
        new UpdateJarCommandValidator().Validate(new UpdateJarCommand(
            Guid.NewGuid(), "Holiday", JarKind.Goal, 300m, midMonth, AccrualMethod.TargetByDate, account, MonthOnly: null))
            .IsValid.Should().BeTrue();
    }

    [Fact]
    public async Task Update_TurningJustTheMonthOnOrOff_ChangesOnlyHowTheDateReads()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(3);
        var bill = await CreateAsync(db, account, due, monthOnly: false, kind: JarKind.Recurring, name: "Insurance");
        var linesBefore = await db.BudgetItems.AsNoTracking().Where(i => i.SavingsId == bill.Id).Select(i => i.PlannedAmount).ToListAsync();

        var month = await UpdateAsync(db, account, bill, due, monthOnly: true);

        month.MonthOnly.Should().BeTrue();
        month.Deadline.Should().Be(due);
        month.PlannedThisMonth.Should().Be(bill.PlannedThisMonth);
        // Not a change of definition (P49), so nothing is dated or replanted.
        (await db.JarRevisions.AnyAsync()).Should().BeFalse();
        (await db.BudgetItems.AsNoTracking().Where(i => i.SavingsId == bill.Id).Select(i => i.PlannedAmount).ToListAsync())
            .Should().Equal(linesBefore);
        var stored = await db.Jars.AsNoTracking().SingleAsync();
        stored.TargetDate.Should().Be(due);
        stored.CycleDeadline.Should().Be(due);

        (await UpdateAsync(db, account, month, due, monthOnly: false)).MonthOnly.Should().BeFalse();
    }

    [Fact]
    public async Task Update_FromAnOlderClient_KeepsJustTheMonth_WhileTheDateStaysOnTheFirst()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(3);
        var jar = await CreateAsync(db, account, due, monthOnly: true);

        // A client loaded before this deploy sends no answer: the stored one stands.
        var kept = await UpdateAsync(db, account, jar, due.AddMonths(1), monthOnly: null);
        kept.MonthOnly.Should().BeTrue();

        // A day other than the 1st is a full date, whatever was stored.
        var dated = await UpdateAsync(db, account, kept, due.AddDays(9), monthOnly: null);
        dated.MonthOnly.Should().BeFalse();
    }

    [Fact]
    public async Task Update_ToAFixedMonthlyPlan_DropsJustTheMonth()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = await CreateAsync(db, account, MonthStart.AddMonths(3), monthOnly: true);

        var pot = await UpdateAsync(db, account, jar, null, monthOnly: true, accrual: AccrualMethod.FixedMonthly, monthly: 50m);

        pot.MonthOnly.Should().BeFalse();
        (await db.Jars.AsNoTracking().SingleAsync()).MonthOnly.Should().BeFalse();
    }

    [Fact]
    public void ARepeatingMonth_RollsOnToTheFirstOfEachLaterMonth()
    {
        var jar = new Jar { Kind = JarKind.Recurring, TargetDate = new DateOnly(2027, 1, 1), RecurMonths = 1, MonthOnly = true };

        JarSchedule.NextCycleDeadline(jar, new DateOnly(2027, 1, 1)).Should().Be(new DateOnly(2027, 2, 1));
        JarSchedule.NextCycleDeadline(jar, new DateOnly(2027, 2, 1)).Should().Be(new DateOnly(2027, 3, 1));
    }

    [Fact]
    public async Task Messages_NameTheMonth_ForAJarDueInAMonth()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(2);
        var created = await CreateAsync(db, account, due, monthOnly: true, kind: JarKind.Recurring, name: "Insurance");
        var jar = await db.Jars.SingleAsync();
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 100m, Today);
        var wrong = due.AddMonths(1);

        (await Assert.ThrowsAsync<ValidationException>(() => new MarkJarCyclePaidCommandHandler(db, new CurrentUserStub(Owner))
                .Handle(new MarkJarCyclePaidCommand(jar.Id, wrong, payment.Id), CancellationToken.None)))
            .Errors["Deadline"][0].Should().Be(
                $"Insurance has no cycle due {wrong:MMM yyyy}. Its current cycle is due {due:MMM yyyy}.");
        (await Assert.ThrowsAsync<ValidationException>(() => new DismissJarCycleCommandHandler(db, new CurrentUserStub(Owner))
                .Handle(new DismissJarCycleCommand(jar.Id, due), CancellationToken.None)))
            .Errors["Deadline"][0].Should().Be(
                $"Insurance's cycle due {due:MMM yyyy} has not been missed; there is nothing to dismiss.");

        // Changing the date to a month that already has a recorded cycle names the month.
        var recorded = MonthStart.AddMonths(-1);
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = jar.Id, Deadline = recorded, TargetAmount = 300m, Outcome = JarCycleOutcome.Missed,
            BalanceAtDeadline = 0m, ClosedOn = recorded, CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
        (await Assert.ThrowsAsync<ValidationException>(() => UpdateAsync(db, account, created, recorded, monthOnly: true)))
            .Errors[nameof(UpdateJarCommand.TargetDate)].Single().Should().Be(
                $"A cycle due in {recorded:MMM yyyy} is already recorded for Insurance. Pick another month.");
        JarDates.Show(recorded, monthOnly: false).Should().Be(recorded.ToString("d MMM yyyy"));
    }

    // ---- A warning while the month runs, missed from the next (7 October 2026) --------------

    private static Jar SeedBill(ApplicationDbContext db, Account account, DateOnly due, bool monthOnly, decimal target = 600m)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = target, TargetDate = due,
            CycleDeadline = due, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12, FundingAccountId = account.Id,
            MonthOnly = monthOnly,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static async Task<JarDto> ReadAsync(ApplicationDbContext db, DateOnly? asOf = null) =>
        (await new GetJarsQueryHandler(db, new CurrentUserStub(Owner)).Handle(new GetJarsQuery(AsOf: asOf), CancellationToken.None)).Single();

    [Fact]
    public async Task ABillDueInAMonth_StillShortWhenItBegins_ReadsBehindWhileItRuns_AndDeadlineMissedFromTheNext()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(1);
        SeedBill(db, account, due, monthOnly: true);
        LedgerFixtures.Allocate(db, Owner, account.Id, (await db.Jars.SingleAsync()).Id, 450m, Today);

        // Read ahead (nothing settles before the real date): the warning from the month's 1st to its last day.
        foreach (var day in new[] { due, due.AddDays(14), due.AddMonths(1).AddDays(-1) })
        {
            var during = await ReadAsync(db, day);
            during.Status.Should().Be("Behind", $"{day} is within the month");
            during.Shortfall.Should().BeNull();
            during.Deadline.Should().Be(due);
        }
        var after = await ReadAsync(db, due.AddMonths(1));
        after.Status.Should().Be("DeadlineMissed");
        after.Shortfall.Should().Be(150m);

        // The same bill with a full date is missed on the day itself.
        var dated = await db.Jars.SingleAsync();
        dated.MonthOnly = false;
        db.SaveChanges();
        (await ReadAsync(db, due)).Status.Should().Be("DeadlineMissed");
    }

    [Fact]
    public async Task AGoalNeededByAMonth_ReadsBehindFromItsFirst_AndNeverMissed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var due = MonthStart.AddMonths(1);
        var goal = await CreateAsync(db, account, due, monthOnly: true);
        LedgerFixtures.Allocate(db, Owner, account.Id, goal.Id, 100m, Today);

        (await ReadAsync(db, due)).Status.Should().Be("Behind");
        (await ReadAsync(db, due.AddMonths(2))).Status.Should().Be("Behind");
    }

    [Fact]
    public async Task ShortWhenTheMonthBegan_ButHeldByItsEnd_RollsForwardFunded_OnTheFirstOfTheNext()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m, openingDate: new DateOnly(2025, 1, 1));
        var march = new DateOnly(2026, 3, 1);
        var jar = SeedBill(db, account, march, monthOnly: true);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, new DateOnly(2026, 2, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 150m, new DateOnly(2026, 3, 20));

        // While March runs nothing is judged.
        await JarCycles.SettleAsync(db, Owner, new DateOnly(2026, 3, 25), CancellationToken.None);
        (await db.JarCycles.AnyAsync()).Should().BeFalse();
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(march);

        // March is over with the 600 held at its end: on time.
        await JarCycles.SettleAsync(db, Owner, new DateOnly(2026, 4, 1), CancellationToken.None);
        var cycle = await db.JarCycles.AsNoTracking().SingleAsync();
        cycle.Outcome.Should().Be(JarCycleOutcome.Funded);
        cycle.Deadline.Should().Be(march);
        cycle.ClosedOn.Should().Be(new DateOnly(2026, 4, 1));
        cycle.BalanceAtDeadline.Should().Be(600m);
        cycle.MonthOnly.Should().BeTrue();
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(new DateOnly(2027, 3, 1));
    }

    [Fact]
    public async Task ShortAtTheMonthsEnd_StaysOpen_AsDeadlineMissed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m, openingDate: new DateOnly(2025, 1, 1));
        var march = new DateOnly(2026, 3, 1);
        var jar = SeedBill(db, account, march, monthOnly: true);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, new DateOnly(2026, 2, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 150m, new DateOnly(2026, 4, 1)); // the 1st of the next month is too late

        await JarCycles.SettleAsync(db, Owner, new DateOnly(2026, 4, 5), CancellationToken.None);

        (await db.JarCycles.AnyAsync()).Should().BeFalse();
        (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(march);
    }

    [Fact]
    public async Task WhileTheMonthRuns_ItCannotBeDismissed_AndAnEditMovesItWithoutRecordingAMiss()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var bill = await CreateAsync(db, account, MonthStart, monthOnly: true, kind: JarKind.Recurring, name: "Insurance");

        (await ReadAsync(db)).Status.Should().Be("Behind");
        (await Assert.ThrowsAsync<ValidationException>(() => new DismissJarCycleCommandHandler(db, new CurrentUserStub(Owner))
                .Handle(new DismissJarCycleCommand(bill.Id, MonthStart), CancellationToken.None)))
            .Errors["Deadline"][0].Should().Be(
                $"Insurance's cycle due {MonthStart:MMM yyyy} has not been missed; there is nothing to dismiss.");

        var moved = await UpdateAsync(db, account, bill, MonthStart.AddMonths(1), monthOnly: true);

        moved.Deadline.Should().Be(MonthStart.AddMonths(1));
        (await db.JarCycles.AnyAsync()).Should().BeFalse();
    }

    [Fact]
    public async Task APaymentWithinTheMonth_IsOnTime()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var bill = await CreateAsync(db, account, MonthStart, monthOnly: true, kind: JarKind.Recurring, name: "Insurance");
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 300m, Today);

        var paid = await new MarkJarCyclePaidCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new MarkJarCyclePaidCommand(bill.Id, MonthStart, payment.Id), CancellationToken.None);

        paid.LastCycle!.Outcome.Should().Be("Paid");
        paid.LastCycle.PaidOnTime.Should().BeTrue();
        (await db.JarCycles.AsNoTracking().SingleAsync()).MonthOnly.Should().BeTrue();

        // The rule, on the cycle itself: on time until the month is over; a full date only before its day.
        var march = new DateOnly(2027, 3, 1);
        Cycle(march, new DateOnly(2027, 3, 31), monthOnly: true).PaidOnTime.Should().BeTrue();
        Cycle(march, new DateOnly(2027, 4, 1), monthOnly: true).PaidOnTime.Should().BeFalse();
        Cycle(march, new DateOnly(2027, 3, 1), monthOnly: false).PaidOnTime.Should().BeFalse();
        Cycle(march, new DateOnly(2027, 2, 28), monthOnly: false).PaidOnTime.Should().BeTrue();

        static JarCycle Cycle(DateOnly deadline, DateOnly paidOn, bool monthOnly) =>
            new() { Deadline = deadline, Outcome = JarCycleOutcome.Paid, PaidOn = paidOn, MonthOnly = monthOnly };
    }

    [Fact]
    public async Task AWaitingCycleDueInAMonth_IsJudgedWhenTheMonthIsOver_ByWhatWasHeldAtItsEnd()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m, openingDate: new DateOnly(2025, 1, 1));
        var march = new DateOnly(2026, 3, 1);
        var jar = SeedBill(db, account, new DateOnly(2027, 3, 1), monthOnly: true);
        // A cycle paid ahead whose payment was deleted (D17): it waits, unjudged.
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = jar.Id, Deadline = march, TargetAmount = 600m, Outcome = JarCycleOutcome.Funded,
            BalanceAtDeadline = null, ClosedOn = march, MonthOnly = true, CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, new DateOnly(2026, 2, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 150m, new DateOnly(2026, 3, 20));

        await JarCycles.SettleAsync(db, Owner, new DateOnly(2026, 3, 25), CancellationToken.None);
        (await db.JarCycles.AsNoTracking().SingleAsync()).BalanceAtDeadline.Should().BeNull("March is still running");

        await JarCycles.SettleAsync(db, Owner, new DateOnly(2026, 4, 1), CancellationToken.None);
        var judged = await db.JarCycles.AsNoTracking().SingleAsync();
        judged.Outcome.Should().Be(JarCycleOutcome.Funded);
        judged.BalanceAtDeadline.Should().Be(600m);
    }
}
