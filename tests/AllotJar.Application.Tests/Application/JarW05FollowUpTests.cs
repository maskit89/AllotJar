using System.Reflection;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarPayments;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The findings the PR #275 (W05) reviews left for a follow-up (P2-15 is pinned in
/// <c>JarMonthViewW05Tests</c>, beside the case it completes): restoring a jar keeps
/// the months it spent archived (P2-19); moving a jar into an account leaves that account's earlier
/// payments on the jar's line where they were (P2-20); an out-of-range month is a 400, not a 500
/// (P3-5); one read of the jars loads the ledger once, and a jar write a bounded number of times
/// (P3-6, P3-10); a move made before departures were recorded is settled at startup (P3-8); two
/// writers settling the same departure cannot overwrite each other (P3-9).
/// </summary>
public class JarW05FollowUpTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static DateOnly Deadline => new(Today.Year + 1, 7, 1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-w05-follow-up-{Guid.NewGuid()}")
            .Options);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m, TargetDate = Deadline,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A budget month with a Savings line per jar given (planned amounts as given).</summary>
    private static IReadOnlyList<BudgetItem> SeedMonth(ApplicationDbContext db, DateOnly month, params (Jar Jar, decimal Planned)[] lines)
    {
        var items = lines.Select(l => new BudgetItem { Name = l.Jar.Name, PlannedAmount = l.Planned, SavingsId = l.Jar.Id }).ToList();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = items } },
        });
        db.SaveChanges();
        return items;
    }

    /// <summary>An expense line (no jar) added to the budget month already seeded for <paramref name="month"/>.</summary>
    private static BudgetItem SeedExpenseLine(ApplicationDbContext db, DateOnly month, string name)
    {
        var budget = db.BudgetMonths.Single(m => m.Year == month.Year && m.Month == month.Month);
        var item = new BudgetItem { Name = name, PlannedAmount = 400m };
        db.Add(new BudgetCategory
        {
            BudgetMonthId = budget.Id, Name = "Living", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { item },
        });
        db.SaveChanges();
        return item;
    }

    private static Task<IReadOnlyList<JarDto>> ReadAsync(IApplicationDbContext db, DateOnly? month, DateOnly? asOf = null) =>
        new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(AsOf: asOf, Month: month), Ct);

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid jarId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).BalanceOf(jarId);

    private static UpdateJarCommand MoveTo(Jar jar, Guid accountId) =>
        new(jar.Id, jar.Name, JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, accountId);

    // ---- P2-19 -------------------------------------------------------------------------------

    [Fact]
    public async Task P2_19_RestoringAJar_KeepsTheMonthsItSpentArchived()
    {
        // Insurance, 300 due 15 Aug; 100 went in on 1 Jul and came out on 20 Jul, when the jar was
        // archived. August has no line for it: while archived, August lists no jar.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 8, 15), CycleDeadline = new DateOnly(2026, 8, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
            IsArchived = true, ArchivedOn = new DateOnly(2026, 7, 20),
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 7, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, -100m, new DateOnly(2026, 7, 20), JarAllocationKind.Reallocation);
        SeedMonth(db, new DateOnly(2026, 7, 1), (bill, 100m));
        SeedMonth(db, new DateOnly(2026, 8, 1));
        var august = new DateOnly(2026, 8, 1);
        (await ReadAsync(db, august)).Should().BeEmpty();

        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(bill.Id, Archived: false), Ct);

        // August is over and the jar was archived all through it: restoring it today rewrites nothing.
        (await ReadAsync(db, august)).Should().BeEmpty();
        // July (its line, archived on the 20th) still reads the jar as archived at the month's end.
        var july = (await ReadAsync(db, new DateOnly(2026, 7, 1))).Single();
        july.Status.Should().NotBe("DeadlineMissed");
        // The archive period is kept, so a second archive and restore keeps both.
        var periods = await db.JarArchivePeriods.Where(p => p.JarId == bill.Id).ToListAsync();
        periods.Should().ContainSingle().Which.Should().Match<JarArchivePeriod>(p =>
            p.ArchivedOn == new DateOnly(2026, 7, 20) && p.RestoredOn == Today);
        // The current month reads it live again.
        (await ReadAsync(db, null)).Should().ContainSingle(j => j.Id == bill.Id);
    }

    [Fact]
    public void P2_19_IsArchivedOn_ReadsTheArchivePeriods()
    {
        var jar = new Jar { IsArchived = false, ArchivedOn = null };
        var periods = new[] { new JarArchivePeriod { ArchivedOn = new DateOnly(2026, 7, 20), RestoredOn = new DateOnly(2026, 9, 29) } };

        var july = JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 7, 31));
        july.IsArchived.Should().BeTrue();
        july.ArchivedOn.Should().Be(new DateOnly(2026, 7, 20));
        JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 7, 19)).IsArchived.Should().BeFalse();
        // The restore day is live again.
        JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 9, 29)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task P2_D_APastMonthCreatedAfterARestore_PlantsNoLineForAJarArchivedAllThroughIt()
    {
        // Holiday was archived on the 1st three months ago and restored today. Creating the month
        // two months ago plants nothing for it; creating one before the archive still does.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var jar = SeedGoal(db, account);
        var thisMonth = new DateOnly(Today.Year, Today.Month, 1);
        db.JarArchivePeriods.Add(new JarArchivePeriod { JarId = jar.Id, ArchivedOn = thisMonth.AddMonths(-3), RestoredOn = Today });
        db.SaveChanges();
        var create = new CreateBudgetMonthCommandHandler(db, User);

        var archived = await create.Handle(new CreateBudgetMonthCommand(thisMonth.AddMonths(-2).Year, thisMonth.AddMonths(-2).Month, CopyFromPrevious: false), Ct);
        var before = await create.Handle(new CreateBudgetMonthCommand(thisMonth.AddMonths(-4).Year, thisMonth.AddMonths(-4).Month, CopyFromPrevious: false), Ct);

        archived.Categories.SelectMany(c => c.Items).Should().NotContain(i => i.SavingsId == jar.Id);
        before.Categories.SelectMany(c => c.Items).Should().ContainSingle(i => i.SavingsId == jar.Id);
    }

    // ---- P2-20 -------------------------------------------------------------------------------

    [Fact]
    public async Task P2_20_MovingAJarIntoAnAccount_LeavesThatAccountsEarlierLinePaymentsWhereTheyWere()
    {
        // Holiday is in A and holds 0; on 20 Aug a 50 payment from B went on Holiday's August line,
        // so it drew from B's unallocated money. Moving Holiday to B must not pull it onto the jar.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 100m)).Single();
        var old = LedgerFixtures.Expense(db, Owner, b.Id, 50m, new DateOnly(2026, 8, 20), line.Id);

        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 25))).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[b.Id].Unallocated.Should().Be(950m);
        // A payee edit of the old payment keeps it on B's unallocated money.
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(old.Id, old.Date, "Travel agent", 50m, TransactionType.Expense, b.Id), Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        // Nothing is stuck: the jar can be archived.
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
    }

    [Fact]
    public async Task P2_20_APaymentOnTheJarsLineFromItsNewAccount_DrawsFromTheJarFromTheMoveDay()
    {
        // Review of #276, P2-A: from the move on, the new account is the only one a payment on the
        // jar's line can be recorded from, so one dated on the move day comes out of the jar.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m)).Single();

        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(b.Id, null, jar.Id, 300m, Today), Ct);
        var deposit = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Travel agent", 300m, TransactionType.Expense, line.Id, AccountId: b.Id), Ct);

        (await db.Jars.SingleAsync(j => j.Id == jar.Id)).FundingAccountSince.Should().Be(Today);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, Today.AddDays(1))).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[b.Id].Unallocated.Should().Be(700m);
        (await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(jar.Id), Ct))
            .Should().ContainSingle(p => p.Id == deposit.Id && p.FromJar);
    }

    [Fact]
    public async Task P2_20_ABillPaidOnTheMoveDay_MarkedPaid_LeavesNothingHeld()
    {
        // Review of #276, P2-A (H2): the payment the cycle is marked paid with came out of the jar,
        // so nothing is carried into the next cycle.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var due = Today.AddDays(20);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m, TargetDate = due,
            CycleDeadline = due, RecurMonths = 12, Accrual = AccrualMethod.TargetByDate, FundingAccountId = a.Id,
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (bill, 300m)).Single();

        await new UpdateJarCommandHandler(db, User).Handle(
            new UpdateJarCommand(bill.Id, "Insurance", JarKind.Recurring, 300m, due, AccrualMethod.TargetByDate, b.Id, RecurMonths: 12), Ct);
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(b.Id, null, bill.Id, 300m, Today), Ct);
        var paid = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Insurer", 300m, TransactionType.Expense, line.Id, AccountId: b.Id), Ct);
        var marked = await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(bill.Id, due, paid.Id), Ct);

        marked.CurrentBalance.Should().Be(0m);
        marked.Status.Should().NotBe("FullyFunded");
    }

    [Fact]
    public async Task P2_20_APaymentOnTheJarsLineDatedBeforeTheMove_IsRefused_FromEitherAccount()
    {
        // Review of #276, P2-A (Lead2): from B a payment dated before the move would stay on B's
        // unallocated money, so it is refused, with the day the jar arrived, and a date edit
        // can't move a payment there either. Holiday had nothing in A, so the move recorded no
        // stretch there (R2-D1 accepts A's payments only in a recorded stretch): from A it is
        // refused too, with the same day and no advice to record it from B (round 2, R2-P3-1).
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m)).Single();
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        var arrived = Today;
        var before = arrived.AddDays(-1);

        var fromA = () => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(before, "Travel agent", 30m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        var fromB = () => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(before, "Travel agent", 30m, TransactionType.Expense, line.Id, AccountId: b.Id), Ct);

        (await fromA.Should().ThrowAsync<ValidationException>()).Which.Errors.SelectMany(e => e.Value)
            .Should().ContainSingle().Which.Should().Contain($"moved to B on {arrived:d MMM yyyy}")
            .And.Contain("can't be added to its line from any account").And.NotContain("Record this payment from B");
        (await fromB.Should().ThrowAsync<ValidationException>()).Which.Errors.SelectMany(e => e.Value)
            .Should().ContainSingle(m => m.Contains($"moved to B on {arrived:d MMM yyyy}"));
        var onTheDay = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(arrived, "Travel agent", 30m, TransactionType.Expense, line.Id, AccountId: b.Id), Ct);
        var redate = () => new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(onTheDay.Id, before, "Travel agent", 30m, TransactionType.Expense, b.Id), Ct);
        await redate.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task P2_20_APaymentTheJarMadeInItsOldAccount_CanStillBeRedatedBeforeTheMove()
    {
        // The refusal is for the account the jar joined: a payment it made in A before the move
        // keeps P51's rule, a date edit within the stretch before the move.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, new DateOnly(2026, 8, 1));
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 100m)).Single();
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 8, 20), line.Id);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(payment.Id, new DateOnly(2026, 8, 21), "Travel agent", 100m, TransactionType.Expense, a.Id), Ct);

        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 20))).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 21))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
    }

    [Fact]
    public async Task P2_20_ThatAccountsPaymentRecordedBeforeTheMove_DatedOnTheMoveDay_StaysOnItsUnallocatedMoney()
    {
        // Review of #276, P2-A: a payment from B on Holiday's line made before Holiday moved to B
        // (the payee auto-categoriser skips the account check) is written down at the move as it
        // read then, so the move day's rule doesn't pull it onto the jar, and an edit keeps it there.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m)).Single();
        var early = LedgerFixtures.Expense(db, Owner, b.Id, 50m, Today, line.Id);

        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[b.Id].Unallocated.Should().Be(950m);
        (await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(jar.Id), Ct)).Should().BeEmpty();
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(early.Id, Today, "Shop", 50m, TransactionType.Expense, b.Id), Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
    }

    [Fact]
    public async Task P2_20_ARoundTripTheSameDay_PaymentsFromTheJarsAccountDrawFromIt()
    {
        // Review of #276, P2-A (H5): moved to B and back to A the same day (an undo); a payment
        // from A on the line that day comes out of the jar.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m)).Single();
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, a.Id), Ct);

        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(a.Id, null, jar.Id, 300m, Today), Ct);
        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Travel agent", 100m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(200m);
    }

    [Fact]
    public async Task P2_20_AMoveDayPaymentPaidFromAnotherJar_PutOnTheJarsLine_DrawsFromTheJar()
    {
        // Review of #276 round 2, R2-P2-1: on the day Holiday moved to B, two 80 payments from B
        // on Groceries were answered "paid from Car" (a jar B holds). One is moved onto Holiday's
        // line as the form sends it (no paid-from on a jar line), then its payee edited; the other
        // is split 50 Holiday + 30 Groceries with the form's pre-filled "Car". Holiday's share of
        // each comes out of Holiday, not Car or B's unallocated money.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var holiday = SeedGoal(db, a);
        var car = SeedGoal(db, b, "Car");
        var month = new DateOnly(Today.Year, Today.Month, 1);
        var holidayLine = SeedMonth(db, month, (holiday, 100m), (car, 100m))[0];
        var groceries = SeedExpenseLine(db, month, "Groceries");
        var fund = new ReallocateJarMoneyCommandHandler(db, User);
        await fund.Handle(new ReallocateJarMoneyCommand(b.Id, null, car.Id, 100m, Today), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(holiday, b.Id), Ct);
        await fund.Handle(new ReallocateJarMoneyCommand(b.Id, null, holiday.Id, 300m, Today), Ct);
        var create = new CreateTransactionCommandHandler(db, User);
        var moved = await create.Handle(
            new CreateTransactionCommand(Today, "Shop", 80m, TransactionType.Expense, groceries.Id, AccountId: b.Id, PaidFromJarId: car.Id), Ct);
        var split = await create.Handle(
            new CreateTransactionCommand(Today, "Shop", 80m, TransactionType.Expense, groceries.Id, AccountId: b.Id, PaidFromJarId: car.Id), Ct);

        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(moved.Id, holidayLine.Id), Ct);
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(moved.Id, Today, "Travel agent", 80m, TransactionType.Expense, b.Id), Ct);
        await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(split.Id, new[]
        {
            new SplitAllocationInput(holidayLine.Id, 50m), new SplitAllocationInput(groceries.Id, 30m),
        }, PaidFromJarId: car.Id), Ct);

        var ledger = await JarLedgerReader.ReadAsync(db, Owner, Today, Ct);
        ledger.BalanceOf(holiday.Id).Should().Be(170m);
        ledger.BalanceOf(car.Id).Should().Be(70m);
        ledger.Accounts[b.Id].Unallocated.Should().Be(600m);
        (await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(holiday.Id), Ct))
            .Should().Contain(p => p.Id == moved.Id && p.FromJar);
    }

    [Fact]
    public async Task P2_20_AMoveDayPaymentKeptFromAJarThatLeftTheSameDay_PutOnTheJarsLine_DrawsFromTheJar()
    {
        // Review of #276 round 2, R2-P2-1: a 100 payment from B on Bike's line drew from Bike;
        // Bike moved to C and Holiday to B the same day, so B's leg keeps Bike's draw. Moved onto
        // Holiday's line, it comes out of Holiday.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 1000m, order: 2);
        var holiday = SeedGoal(db, a);
        var bike = SeedGoal(db, b, "Bike");
        var lines = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (holiday, 100m), (bike, 100m));
        var fund = new ReallocateJarMoneyCommandHandler(db, User);
        await fund.Handle(new ReallocateJarMoneyCommand(b.Id, null, bike.Id, 100m, Today), Ct);
        var payment = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Bike shop", 100m, TransactionType.Expense, lines[1].Id, AccountId: b.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(bike, c.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(holiday, b.Id), Ct);
        await fund.Handle(new ReallocateJarMoneyCommand(b.Id, null, holiday.Id, 300m, Today), Ct);

        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(payment.Id, lines[0].Id), Ct);

        (await BalanceAsync(db, holiday.Id, Today)).Should().Be(200m);
        (await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(holiday.Id), Ct))
            .Should().ContainSingle(p => p.Id == payment.Id && p.FromJar);
    }

    [Fact]
    public async Task P51_AfterTheJarMovesAwayAndBack_ItsEarlierPaymentsThereCanStillBeRedatedAndResplit()
    {
        // Review of #276 round 2, R2-P2-2: Holiday held 400 in A from 1 Aug and paid 150 on 3 Aug
        // and 250 on 4 Aug from its line. Today it moved to B and back to A (an undo). Those two
        // payments are still its draws there, so a date edit or a re-split within that stretch is
        // accepted and reads as P51 says. So is a new payment A made in that stretch and entered
        // late (R2-D1, "Accept and settle"): it draws from the jar there and the move is re-settled.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var august = new DateOnly(2026, 8, 1);
        var line = SeedMonth(db, august, (jar, 100m)).Single();
        var eatingOut = SeedExpenseLine(db, august, "Eating out");
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(a.Id, null, jar.Id, 400m, august), Ct);
        var create = new CreateTransactionCommandHandler(db, User);
        var flights = await create.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 3), "Flights", 150m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        var hotel = await create.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 4), "Hotel", 250m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, a.Id), Ct);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(hotel.Id, new DateOnly(2026, 8, 5), "Hotel", 250m, TransactionType.Expense, a.Id), Ct);
        await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(flights.Id, new[]
        {
            new SplitAllocationInput(line.Id, 100m), new SplitAllocationInput(eatingOut.Id, 50m),
        }), Ct);

        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 4))).Should().Be(300m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 5))).Should().Be(50m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated.Should().Be(600m);
        await create.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 6), "Insurance", 50m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 6))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated.Should().Be(550m);
    }

    [Fact]
    public async Task P51_AfterTheJarMovesAwayAndBack_ItsEarlierPaymentsThereCanBeRedatedIntoTheNextMonth()
    {
        // Review of #276 round 3, R3-P3-1: Holiday held 350 in A from 1 Aug; from its line it paid
        // 100 of a 150 payment on 28 Aug (the rest on Eating out) and 250 on 30 Aug. Today it moved to B
        // and back to A. Re-dating either into September (acknowledged, as the form asks) re-runs
        // the whole line's checks, which must leave these draws to their departure as a date
        // edit within the month does.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var august = new DateOnly(2026, 8, 1);
        var line = SeedMonth(db, august, (jar, 100m)).Single();
        var eatingOut = SeedExpenseLine(db, august, "Eating out");
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(a.Id, null, jar.Id, 350m, august), Ct);
        var create = new CreateTransactionCommandHandler(db, User);
        var flights = await create.Handle(new CreateTransactionCommand(
            new DateOnly(2026, 8, 28), "Flights", 150m, TransactionType.Expense, null, AccountId: a.Id,
            Splits: new[] { new SplitAllocationInput(line.Id, 100m), new SplitAllocationInput(eatingOut.Id, 50m) }), Ct);
        var hotel = await create.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 30), "Hotel", 250m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, a.Id), Ct);

        var update = new UpdateTransactionCommandHandler(db, User);
        await update.Handle(new UpdateTransactionCommand(
            flights.Id, new DateOnly(2026, 9, 1), "Flights", 150m, TransactionType.Expense, a.Id, AcknowledgeCrossMonth: true), Ct);
        await update.Handle(new UpdateTransactionCommand(
            hotel.Id, new DateOnly(2026, 9, 2), "Hotel", 250m, TransactionType.Expense, a.Id, AcknowledgeCrossMonth: true), Ct);

        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 31))).Should().Be(350m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 9, 1))).Should().Be(250m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 9, 2))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
    }

    // ---- P3-5 --------------------------------------------------------------------------------

    [Theory]
    [InlineData(9999, 12, null)]
    [InlineData(1, 1, null)]
    [InlineData(null, null, "9999-12-31")]
    [InlineData(null, null, "0001-01-01")]
    public void P3_5_AMonthOrDateOutsideTheBudgetRange_IsAValidationError(int? year, int? month, string? asOf)
    {
        var query = new GetJarsQuery(
            AsOf: asOf is null ? null : DateOnly.Parse(asOf),
            Month: year is { } y ? new DateOnly(y, month!.Value, 1) : null);

        new GetJarsQueryValidator().Validate(query).IsValid.Should().BeFalse();
    }

    [Fact]
    public void P3_5_AnOrdinaryMonth_IsValid() =>
        new GetJarsQueryValidator().Validate(new GetJarsQuery(AsOf: new DateOnly(2026, 10, 10), Month: new DateOnly(2026, 9, 1))).IsValid.Should().BeTrue();

    // ---- P3-6 / P3-10 ------------------------------------------------------------------------

    /// <summary>Counts every <see cref="IApplicationDbContext"/> member read, to count ledger loads (one read of <c>Accounts</c> per load).</summary>
    public class CountingContext : DispatchProxy
    {
        public IApplicationDbContext Inner { get; set; } = null!;
        public Dictionary<string, int> Counts { get; } = new();

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            var name = targetMethod!.Name;
            Counts[name] = Counts.GetValueOrDefault(name) + 1;
            try
            {
                return targetMethod.Invoke(Inner, args);
            }
            catch (TargetInvocationException ex) when (ex.InnerException is not null)
            {
                throw ex.InnerException;
            }
        }

        public static (IApplicationDbContext Db, CountingContext Counter) Wrap(IApplicationDbContext inner)
        {
            var proxy = Create<IApplicationDbContext, CountingContext>();
            var counter = (CountingContext)(object)proxy;
            counter.Inner = inner;
            return (proxy, counter);
        }

        public int LedgerLoads => Counts.GetValueOrDefault("get_Accounts");
    }

    [Fact]
    public async Task P3_6_OneReadOfAPastMonthsJars_LoadsTheLedgerOnce()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 200m, new DateOnly(2026, 8, 20));
        var (counting, counter) = CountingContext.Wrap(db);

        var september = (await ReadAsync(counting, new DateOnly(2026, 9, 1), new DateOnly(2026, 10, 10))).Single();

        september.CurrentBalance.Should().Be(200m);
        counter.LedgerLoads.Should().Be(1);
    }

    [Fact]
    public async Task P3_10_AJarEdit_LoadsTheLedgerOnceBeforeAndOnceAfterTheSave()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m));
        var (counting, counter) = CountingContext.Wrap(db);

        // A new target: the replant reads the ledger as it was before the edit, the card after it.
        var card = await new UpdateJarCommandHandler(counting, User).Handle(
            new UpdateJarCommand(jar.Id, jar.Name, JarKind.Goal, 2400m, Deadline, AccrualMethod.TargetByDate, account.Id), Ct);

        card.TargetAmount.Should().Be(2400m);
        counter.LedgerLoads.Should().Be(2);
    }

    // ---- P3-8 --------------------------------------------------------------------------------

    [Fact]
    public async Task P3_8_AMoveMadeBeforeDeparturesWereRecorded_IsSettledByTheBackfill_Once()
    {
        // Holiday held 100 in A and paid 100 from its line on 20 Aug; it moved to B on main (no
        // departure), and main's edit then corrected the kept payment to 80 without settling: A's
        // ledger holds 20 of Holiday, which blocked its archive until a kept entry was edited.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, new DateOnly(2026, 8, 1));
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 100m)).Single();
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 8, 20), line.Id);
        await JarMovements.KeepLineAttributionAsync(db, Owner, jar, new DateOnly(2026, 9, 1), Ct);
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);
        var op = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.TransactionId == payment.Id);
        op.Postings.Single(p => p.JarId == jar.Id).Amount = -80m;
        payment.Amount = 80m;
        await db.SaveChangesAsync(Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(20m);

        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(1);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        // Dated on the last day A's ledger touched the jar: the history before it is unchanged.
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 19))).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(0);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
    }

    [Fact]
    public async Task P3_8_AMoveMadeBefore274_WritesDownTheOldAccountsLinePaymentsBeforeDatingTheDeparture()
    {
        // Review of #276, P2-B: a move on the code before #274 wrote nothing down, so the 20 Aug
        // payment from A on Holiday's line lost the jar and A's postings (500 in on 15 Jul) read
        // 500 left over. The backfill writes the payment down as it read then and dates the
        // departure on it: July still reads the 500 Holiday held, and A's money is unchanged.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 500m, new DateOnly(2026, 7, 15));
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 500m)).Single();
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 500m, new DateOnly(2026, 8, 20), line.Id);
        var unallocated = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated;
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);

        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(1);

        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 7, 31))).Should().Be(500m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 19))).Should().Be(500m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated.Should().Be(unallocated);
        var kept = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.TransactionId == payment.Id);
        kept.Postings.Should().ContainSingle(p => p.JarId == jar.Id && p.Amount == -500m);
        var departure = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(new DateOnly(2026, 8, 20));
        departure.Postings.Should().OnlyContain(p => p.Amount == 0m);
        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(0);
    }

    [Fact]
    public async Task P3_8_TheBackfill_WritesDownALinePaymentsOwnAmount_AfterForeignAmountsGaveItABudgetFigure()
    {
        // Merge with #278: ForeignAmounts ran first in production. A row in another currency on an
        // account keeps its amount (the account's money) and either carries the figure it counts
        // in the budget beside it (BudgetAmount) or waits for one (FxPending). Jar balances read
        // the amount, so the backfill writes each payment down at its amount, whatever it counts
        // in the budget: Holiday holds 0 in A, and A keeps the rest as unallocated money.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "UK savings", opening: 1000m, currency: "GBP");
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 500m, new DateOnly(2026, 7, 15));
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 500m)).Single();
        var counted = LedgerFixtures.Expense(db, Owner, a.Id, 200m, new DateOnly(2026, 8, 10), line.Id, currency: "GBP");
        counted.BudgetAmount = 234m;
        var waiting = LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 8, 20), line.Id, currency: "GBP");
        waiting.FxPending = true;
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);

        var result = await JarDepartures.BackfillAsync(db, Ct);

        result.Departures.Should().Be(1);
        result.PaymentsWrittenDown.Should().Be(2);
        var written = await db.JarAllocations.Include(x => x.Postings)
            .Where(x => x.TransactionId == counted.Id || x.TransactionId == waiting.Id).ToListAsync(Ct);
        written.SelectMany(x => x.Postings).Where(p => p.JarId == jar.Id).Select(p => p.Amount)
            .Should().BeEquivalentTo(new[] { -200m, -100m });
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 10))).Should().Be(300m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 19))).Should().Be(300m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        var ledger = await JarLedgerReader.ReadAsync(db, Owner, Today, Ct);
        ledger.Accounts[a.Id].JarBalances.GetValueOrDefault(jar.Id).Should().Be(0m);
        ledger.Accounts[a.Id].Unallocated.Should().Be(700m);
    }

    [Fact]
    public async Task P3_8_TheBackfill_DatesATransferLegOnTheDayItPosts()
    {
        // Review of #276 (H6b): 200 left C on 10 Aug and reached A on 14 Aug, all of it into
        // Holiday (the stored split is dated on the day it left), and Holiday later changed
        // account with nothing written down. A departure dated 10 Aug would read Holiday at -200
        // until the money arrived.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 1000m, order: 2);
        var jar = SeedGoal(db, a);
        var transfer = new Transaction
        {
            OwnerId = Owner, AccountId = c.Id, TransferAccountId = a.Id, Amount = 200m, Currency = CurrencyCode.Eur,
            Type = TransactionType.Transfer, Date = new DateOnly(2026, 8, 10), DepartedOn = new DateOnly(2026, 8, 10),
            ReceivedOn = new DateOnly(2026, 8, 14), Payee = "Transfer",
        };
        db.Transactions.Add(transfer);
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = a.Id, Kind = JarAllocationKind.Movement, Date = new DateOnly(2026, 8, 10),
            Transaction = transfer, CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = 200m } },
        });
        db.SaveChanges();
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);

        await JarDepartures.BackfillAsync(db, Ct);

        (await db.JarAllocations.SingleAsync(x => x.Kind == JarAllocationKind.Departure)).Date.Should().Be(new DateOnly(2026, 8, 14));
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 12))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
    }

    [Fact]
    public async Task P3_8_TheBackfill_SettlesJarSharesOnTransferLegsStillInTransit_SoNothingIsLeftOnceTheyPost()
    {
        // Review of #276 round 2 (R2-P3-4) and round 3 (R3-P2-1): two transfers from C into A put
        // 200 and 100 into Holiday, stored on A's legs, but neither has posted in A: C's statement
        // hasn't confirmed the first left (the receipt came first), and the second's receipt isn't
        // confirmed. Holiday then moved to B before #274. The departure settles both shares, so
        // Holiday reads -300 in A while they are in transit and 0 once they post, for good.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 1000m, order: 2);
        var jar = SeedGoal(db, a);
        Transaction TransferIntoHoliday(decimal amount, DateOnly date, DateOnly? departed, DateOnly? received)
        {
            var transfer = new Transaction
            {
                OwnerId = Owner, AccountId = c.Id, TransferAccountId = a.Id, Amount = amount, Currency = CurrencyCode.Eur,
                Type = TransactionType.Transfer, Date = date, DepartedOn = departed, ReceivedOn = received, Payee = "Transfer",
            };
            db.JarAllocations.Add(new JarAllocation
            {
                OwnerId = Owner, AccountId = a.Id, Kind = JarAllocationKind.Movement, Date = date,
                Transaction = transfer, CreatedUtc = DateTime.UtcNow,
                Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = amount } },
            });
            db.SaveChanges();
            return transfer;
        }
        var receiptFirst = TransferIntoHoliday(200m, new DateOnly(2026, 9, 25), departed: null, received: new DateOnly(2026, 9, 25));
        var notReceived = TransferIntoHoliday(100m, new DateOnly(2026, 9, 24), departed: new DateOnly(2026, 9, 24), received: null);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);

        await JarDepartures.BackfillAsync(db, Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(-300m);
        var confirm = new ConfirmTransferLegsCommandHandler(db, User);
        await confirm.Handle(new ConfirmTransferLegsCommand(receiptFirst.Id, DepartedOn: new DateOnly(2026, 9, 24)), Ct);
        await confirm.Handle(new ConfirmTransferLegsCommand(notReceived.Id, ReceivedOn: new DateOnly(2026, 9, 26)), Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].JarBalances.GetValueOrDefault(jar.Id).Should().Be(0m);
    }

    [Fact]
    public async Task P3_8_TheBackfill_WritesDownNoPaymentDatedBeforeTheOldAccountOpened()
    {
        // Review of #276 round 2, R2-P1-1: A opened on 1 Aug, so its ledger never counted the 100
        // paid on Holiday's July line on 20 Jul. Holiday took 500 on 15 Aug and paid 500 on 20 Aug,
        // then moved to B before #274. Writing the July payment down (or settling the stored
        // postings) would leave Holiday holding 100 in A for good; only the August one is written.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m, openingDate: new DateOnly(2026, 8, 1));
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var july = SeedMonth(db, new DateOnly(2026, 7, 1), (jar, 100m)).Single();
        var august = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 500m)).Single();
        var early = LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 7, 20), july.Id);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 500m, new DateOnly(2026, 8, 15));
        LedgerFixtures.Expense(db, Owner, a.Id, 500m, new DateOnly(2026, 8, 20), august.Id);
        var unallocated = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated;
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);

        (await JarDepartures.BackfillAsync(db, Ct)).Should().Be(new JarBackfill(Departures: 1, PaymentsWrittenDown: 1));

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated.Should().Be(unallocated);
        (await db.JarAllocations.AnyAsync(x => x.TransactionId == early.Id)).Should().BeFalse();
        var departure = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(new DateOnly(2026, 8, 20));
        departure.Postings.Should().OnlyContain(p => p.Amount == 0m);
    }

    [Fact]
    public async Task P3_8_TheBackfill_WritesDownNoPaymentDatedAfterDeparturesWereRecorded()
    {
        // Review of #276 round 2, R2-P2-3: every move since #275 reached production (29 Sep 2026)
        // records a departure, so a payment from the old account dated later never drew from the
        // jar there, though the payee auto-categoriser can still put one on its line. Run on
        // 2 Oct, the backfill leaves the 30 Sep one on A's unallocated money.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(2026, 9, 1), (jar, 300m)).Single();
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 300m, new DateOnly(2026, 9, 1));
        LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 9, 20), line.Id);
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);
        var late = LedgerFixtures.Expense(db, Owner, a.Id, 40m, new DateOnly(2026, 9, 30), line.Id);

        (await JarDepartures.BackfillAsync(db, Ct, today: new DateOnly(2026, 10, 2)))
            .Should().Be(new JarBackfill(Departures: 1, PaymentsWrittenDown: 1));

        (await db.JarAllocations.AnyAsync(x => x.TransactionId == late.Id)).Should().BeFalse();
        var departure = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(new DateOnly(2026, 9, 20));
        departure.Postings.Should().Contain(p => p.JarId == jar.Id && p.Amount == -200m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 9, 25))).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 10, 2))).Should().Be(0m);
    }

    // ---- P3-9 --------------------------------------------------------------------------------

    [Fact]
    public async Task P3_9_TwoWritersSettlingTheSameDeparture_TheSecondIsRefused_NotLost()
    {
        // Two requests load the same departure and each shifts it for its own kept leg; without a
        // lock or a token the second save overwrites the first, and the old account holds a
        // residue of the jar again.
        var name = $"zbb-w05-follow-up-{Guid.NewGuid()}";
        ApplicationDbContext Open() => new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(name).Options);
        Guid departureId;
        await using (var seed = Open())
        {
            var a = LedgerFixtures.SeedAccount(seed, Owner, "A");
            var b = LedgerFixtures.SeedAccount(seed, Owner, "B", order: 1);
            var jar = SeedGoal(seed, b);
            var departure = LedgerFixtures.Allocate(seed, Owner, a.Id, jar.Id, 0m, new DateOnly(2026, 9, 1), JarAllocationKind.Departure);
            departureId = departure.Id;
        }

        await using var first = Open();
        await using var second = Open();
        var one = await first.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Id == departureId);
        var two = await second.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Id == departureId);
        foreach (var posting in one.Postings) posting.Amount += posting.JarId is null ? -20m : 20m;
        foreach (var posting in two.Postings) posting.Amount += posting.JarId is null ? -30m : 30m;
        await first.SaveChangesAsync(Ct);

        var lost = () => second.SaveChangesAsync(Ct);

        await lost.Should().ThrowAsync<DbUpdateConcurrencyException>();
    }
}
