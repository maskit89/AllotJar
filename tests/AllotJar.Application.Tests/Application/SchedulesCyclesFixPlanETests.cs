using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars;
using AllotJar.Application.Budgets.Commands.SkipJarContribution;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.DismissJarCycle;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarPayments;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Fix plan E of the 30 Sep end-to-end check (schedules and cycles): money set aside at creation
/// is the month's opening balance (SC-P2-1, SC-P3-7), a payment linked to a cycle that already
/// rolled forward replants (SC-P2-2), archive and restore keep a skipped month skipped (SC-P2-3),
/// a month that is over is planted toward the cycle open then (SC-P2-4), and deleting the payment
/// that closed a cycle reopens it (MG-P2-2). Handlers read today's UTC date, so every scenario is
/// built relative to it: the deadline is the 1st of the month three months after the current one,
/// so the current month and the two after it are the contribution months (rule 12).
/// </summary>
public class SchedulesCyclesFixPlanETests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly M0 = new(Today.Year, Today.Month, 1);
    private static readonly DateOnly M1 = M0.AddMonths(1);
    private static readonly DateOnly M2 = M0.AddMonths(2);
    private static readonly DateOnly Deadline = M0.AddMonths(3);

    private static CurrentUserStub User => new(Owner);

    private static Task CreateMonthAsync(ApplicationDbContext db, DateOnly month, bool copy = true) =>
        new CreateBudgetMonthCommandHandler(db, User).Handle(new CreateBudgetMonthCommand(month.Year, month.Month, copy), Ct);

    private static Task<IReadOnlyList<JarDto>> ListAsync(ApplicationDbContext db, DateOnly? month = null) =>
        new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(Month: month), Ct);

    private static Task<BudgetItem> LineAsync(ApplicationDbContext db, Guid jarId, DateOnly month) => db.BudgetItems.AsNoTracking()
        .Where(i => i.SavingsId == jarId && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month)
        .SingleAsync();

    private static Jar SeedInsurance(ApplicationDbContext db, Account account, DateOnly due)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m,
            TargetDate = due, CycleDeadline = due, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    // SC-P2-1 / SC-P3-7: the preview, the planted line, the card and a month created early agree.
    [Fact]
    public async Task Money_set_aside_at_creation_is_the_opening_balance_so_the_preview_and_every_month_agree()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        await CreateMonthAsync(db, M0, copy: false);

        var preview = await new GetJarScheduleQueryHandler(db, User).Handle(
            new GetJarScheduleQuery(null, JarKind.Goal, 300m, Deadline, AccrualMethod.TargetByDate, InitialAllocation: 90m), Ct);
        preview.Months.Select(m => m.Planned).Should().Equal(70m, 70m, 70m);

        var created = await new CreateJarCommandHandler(db, User).Handle(
            new CreateJarCommand("Laptop", JarKind.Goal, 300m, Deadline, AccrualMethod.TargetByDate, account.Id, InitialAllocation: 90m), Ct);
        (await LineAsync(db, created.Id, M0)).PlannedAmount.Should().Be(70m);
        created.CurrentBalance.Should().Be(90m);
        created.PlannedThisMonth.Should().Be(70m);
        created.ContributedThisMonth.Should().Be(0m, "the 90 was already saved; nothing went in this month yet");
        created.RemainingThisMonth.Should().Be(70m);

        await CreateMonthAsync(db, M1);
        await CreateMonthAsync(db, M2);
        (await LineAsync(db, created.Id, M1)).PlannedAmount.Should().Be(70m, "the preview listed 70 for the second month");
        (await LineAsync(db, created.Id, M2)).PlannedAmount.Should().Be(70m);
    }

    // SC-P2-2: a cycle rolled forward Funded; the bill is entered later and linked to it.
    [Fact]
    public async Task Linking_a_payment_to_a_cycle_that_rolled_forward_replants_the_next_cycle()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, Today);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, Today.AddDays(-40));
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);

        (await ListAsync(db)).Single().LastCycle!.Outcome.Should().Be("Funded");
        (await LineAsync(db, jar.Id, M0)).PlannedAmount.Should().Be(0m);

        var line = await LineAsync(db, jar.Id, M0);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 550m, Today.AddDays(-1), line.Id);
        var dto = await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, Today, payment.Id), Ct);

        dto.CurrentBalance.Should().Be(50m);
        dto.LastCycle!.Outcome.Should().Be("Paid");
        var expected = JarSchedule.Plan(await db.Jars.AsNoTracking().SingleAsync(), Today, 50m);
        expected.First.Should().BeGreaterThan(0m);
        (await LineAsync(db, jar.Id, M0)).PlannedAmount.Should().Be(expected.First);
        (await LineAsync(db, jar.Id, M1)).PlannedAmount.Should().Be(expected.Months[1].Planned);
        dto.PlannedThisMonth.Should().Be(expected.First);
    }

    // SC-P2-3: as in production, one DbContext per request.
    [Fact]
    public async Task Archive_then_restore_keeps_a_skipped_later_month_skipped()
    {
        var name = $"fix-plan-e-{Guid.NewGuid()}";
        ApplicationDbContext Ctx() => new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(name).Options);
        Guid jarId;
        await using (var db = Ctx())
        {
            var account = LedgerFixtures.SeedAccount(db, Owner);
            await CreateMonthAsync(db, M0, copy: false);
            await CreateMonthAsync(db, M1);
            await CreateMonthAsync(db, M2);
            jarId = (await new CreateJarCommandHandler(db, User).Handle(
                new CreateJarCommand("Laptop", JarKind.Goal, 300m, Deadline, AccrualMethod.TargetByDate, account.Id), Ct)).Id;
        }
        await using (var db = Ctx())
        {
            var m1 = await LineAsync(db, jarId, M1);
            await new SkipJarContributionCommandHandler(db, User).Handle(new SkipJarContributionCommand(m1.Id, true), Ct);
        }
        await using (var db = Ctx())
        {
            await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jarId, true), Ct);
        }
        await using (var db = Ctx())
        {
            var archivedM1 = await LineAsync(db, jarId, M1);
            archivedM1.IsSkipped.Should().BeTrue();
            archivedM1.PlannedAmount.Should().Be(0m);
            (await db.BudgetItems.AnyAsync(i => i.SavingsId == jarId && i.BudgetCategory.BudgetMonth.Month == M2.Month
                && i.BudgetCategory.BudgetMonth.Year == M2.Year)).Should().BeFalse("an unskipped later month's plan is still removed (P40)");
            await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jarId, false), Ct);
        }
        await using (var db = Ctx())
        {
            var restoredM1 = await LineAsync(db, jarId, M1);
            restoredM1.IsSkipped.Should().BeTrue("the user never undid the skip (P44)");
            restoredM1.PlannedAmount.Should().Be(0m);
            (await LineAsync(db, jarId, M0)).PlannedAmount.Should().Be(150m);
            (await LineAsync(db, jarId, M2)).PlannedAmount.Should().Be(150m);
        }
    }

    // SC-P2-4: last month is back-filled after the cycle it belonged to was dismissed.
    [Fact]
    public async Task A_month_that_is_over_is_planted_toward_the_cycle_open_then()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, Today);
        var lastMonth = M0.AddMonths(-1);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 500m, lastMonth.AddDays(-10), JarAllocationKind.Reallocation);

        (await ListAsync(db)).Single().Status.Should().Be("DeadlineMissed");
        await new DismissJarCycleCommandHandler(db, User).Handle(new DismissJarCycleCommand(jar.Id, Today), Ct);

        await CreateMonthAsync(db, lastMonth, copy: false);
        var line = await LineAsync(db, jar.Id, lastMonth);
        // Toward the cycle open then (due today), last month was the last contribution month.
        line.PlannedAmount.Should().Be(100m);
        var shelf = (await ListAsync(db, lastMonth)).Single();
        shelf.Deadline.Should().Be(Today);
        shelf.PlannedThisMonth.Should().Be(100m);
    }

    // MG-P2-2: the bill is unpaid again once its payment is deleted.
    [Fact]
    public async Task Deleting_the_payment_that_closed_the_open_cycle_reopens_it_and_replants()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedInsurance(db, account, Deadline);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, Today.AddDays(-40), JarAllocationKind.Reallocation);
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        var line = await LineAsync(db, jar.Id, M0);
        var before = (await LineAsync(db, jar.Id, M0)).PlannedAmount;
        before.Should().Be(50m);

        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 400m, Today, line.Id);
        await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, Deadline, payment.Id), Ct);
        (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(Deadline.AddMonths(12));

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(payment.Id), Ct);

        (await db.JarCycles.AsNoTracking().CountAsync()).Should().Be(0);
        var reopened = await db.Jars.AsNoTracking().SingleAsync();
        reopened.CycleDeadline.Should().Be(Deadline);
        (await LineAsync(db, jar.Id, M0)).PlannedAmount.Should().Be(50m, "planned toward the reopened cycle from the 450 held again");
        (await LineAsync(db, jar.Id, M1)).PlannedAmount.Should().Be(50m);
        var card = (await ListAsync(db)).Single();
        card.CurrentBalance.Should().Be(450m);
        card.Deadline.Should().Be(Deadline);
        card.LastCycle.Should().BeNull();
    }

    [Fact]
    public async Task Deleting_the_payment_of_an_older_cycle_leaves_it_closed_with_no_payment()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var firstDue = Today.AddDays(-60);
        var jar = SeedInsurance(db, account, firstDue);
        jar.RecurMonths = 1;
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, firstDue.AddDays(-30), JarAllocationKind.Reallocation);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 550m, firstDue.AddDays(-2));

        // The monthly cycles rolled forward Funded (rule 21) and the bill is linked to the first
        // afterwards: later cycles have closed since.
        await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, firstDue, payment.Id), Ct);
        (await db.JarCycles.AsNoTracking().CountAsync(c => c.Deadline > firstDue)).Should().BeGreaterThan(0);
        var openAfter = (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline;

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(payment.Id), Ct);

        var first = await db.JarCycles.AsNoTracking().SingleAsync(c => c.Deadline == firstDue);
        first.PaymentTransactionId.Should().BeNull();
        first.PaidOn.Should().BeNull();
        first.PaidAmount.Should().BeNull();
        first.Outcome.Should().Be(JarCycleOutcome.Funded, "without the payment the jar held its 600 the day before the deadline");
        first.BalanceAtDeadline.Should().Be(600m);
        (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(openAfter);
    }

    [Fact]
    public async Task Deleting_an_early_payment_leaves_the_cycle_to_be_judged_on_its_own_deadline()
    {
        // #301 review P3-1: two cycles marked paid ahead; deleting the first payment can't call
        // its cycle missed 20 days before its deadline. It closes on its deadline and is judged then.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var d1 = Today.AddDays(20);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Phone", Kind = JarKind.Recurring, TargetAmount = 100m, TargetDate = d1, CycleDeadline = d1,
            Accrual = AccrualMethod.TargetByDate, RecurMonths = 1, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 50m, Today.AddDays(-5), JarAllocationKind.Reallocation);
        var p1 = LedgerFixtures.Expense(db, Owner, account.Id, 100m, Today);
        var p2 = LedgerFixtures.Expense(db, Owner, account.Id, 100m, Today);
        await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, d1, p1.Id), Ct);
        var d2 = (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline!.Value;
        await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, d2, p2.Id), Ct);

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(p1.Id), Ct);

        var first = await db.JarCycles.AsNoTracking().SingleAsync(c => c.Deadline == d1);
        first.Outcome.Should().NotBe(JarCycleOutcome.Missed, "its deadline has not come");
        first.ClosedOn.Should().Be(d1);
        first.PaymentTransactionId.Should().BeNull();
        first.BalanceAtDeadline.Should().BeNull("nothing is judged before the deadline");

        // The deadline arrives: the jar held 50 of 100 the day before, so the cycle was missed.
        await JarCycles.SettleAsync(db, Owner, d1, Ct);
        db.ChangeTracker.Clear();
        var judged = await db.JarCycles.AsNoTracking().SingleAsync(c => c.Deadline == d1);
        judged.Outcome.Should().Be(JarCycleOutcome.Missed);
        judged.BalanceAtDeadline.Should().Be(50m);
    }

    [Fact]
    public async Task D17_A_cycle_reopened_before_its_deadline_reads_as_waiting_until_the_deadline()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var d1 = Today.AddDays(20);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Phone", Kind = JarKind.Recurring, TargetAmount = 100m, TargetDate = d1, CycleDeadline = d1.AddMonths(1),
            Accrual = AccrualMethod.TargetByDate, RecurMonths = 1, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        // Its payment was removed while the jar had moved on: the cycle waits unjudged (ReopenPaidByAsync).
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = jar.Id, Deadline = d1, TargetAmount = 100m, Outcome = JarCycleOutcome.Funded,
            BalanceAtDeadline = null, ClosedOn = d1, CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();

        var dto = (await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(), Ct)).Single();

        dto.LastCycle!.Outcome.Should().Be(JarMapping.WaitingOutcome, "nothing is judged before the deadline, so it isn't funded on time yet");
        dto.LastCycle.Deadline.Should().Be(d1);
    }

    [Fact]
    public async Task A_transfers_fee_is_not_offered_or_accepted_as_a_cycles_payment()
    {
        // #301 review P3-2: a fee goes with its transfer, so it can't be the payment a cycle keeps.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var jar = SeedInsurance(db, account, Deadline);
        var transfer = new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.Eur, Date = Today,
            Payee = "To savings", AccountId = account.Id,
        };
        db.Transactions.Add(transfer);
        var fee = LedgerFixtures.Expense(db, Owner, account.Id, 2m, Today);
        fee.FeeForTransfer = transfer;
        db.SaveChanges();

        var act = () => new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, Deadline, fee.Id), Ct);
        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(v => v).Should().Contain(m => m.Contains("transfer's fee"));
        var offered = await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(jar.Id, IncludeOtherPayments: true), Ct);
        offered.Should().NotContain(p => p.Id == fee.Id);
    }

    [Fact]
    public async Task A_cycle_waiting_for_its_deadline_is_judged_and_saved_while_another_jar_sits_missed()
    {
        // #301 review R2-1: the verdict is saved even when no jar rolled forward on this read.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 5000m);
        var d1 = Today.AddDays(-3);
        var phone = new Jar
        {
            OwnerId = Owner, Name = "Phone", Kind = JarKind.Recurring, TargetAmount = 100m, TargetDate = d1.AddMonths(2),
            CycleDeadline = d1.AddMonths(2), Accrual = AccrualMethod.TargetByDate, RecurMonths = 1, FundingAccountId = account.Id,
        };
        // Gym's deadline passed short: the persistent "Deadline missed" state (rule 20).
        var gym = new Jar
        {
            OwnerId = Owner, Name = "Gym", Kind = JarKind.Recurring, TargetAmount = 300m, TargetDate = Today.AddDays(-5),
            CycleDeadline = Today.AddDays(-5), Accrual = AccrualMethod.TargetByDate, RecurMonths = 1, FundingAccountId = account.Id,
        };
        db.Jars.AddRange(phone, gym);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, phone.Id, 50m, Today.AddDays(-30), JarAllocationKind.Reallocation);
        db.JarCycles.Add(new JarCycle
        {
            OwnerId = Owner, JarId = phone.Id, Deadline = d1, TargetAmount = 100m, Outcome = JarCycleOutcome.Funded,
            BalanceAtDeadline = null, ClosedOn = d1, CreatedUtc = DateTime.UtcNow,
        });
        db.SaveChanges();

        await ListAsync(db);

        var stored = await db.JarCycles.AsNoTracking().SingleAsync(c => c.JarId == phone.Id && c.Deadline == d1);
        stored.Outcome.Should().Be(JarCycleOutcome.Missed, "the deadline passed with 50 of 100 held");
        stored.BalanceAtDeadline.Should().Be(50m);
    }
}
