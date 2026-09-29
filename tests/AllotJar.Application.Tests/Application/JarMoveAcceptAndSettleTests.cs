using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJarPayments;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// R2-D1, "Accept and settle" (Christopher, 29 September 2026): a payment the jar's old account
/// really made before the jar moved, entered after the move, goes on the jar's line. It is stored
/// as a draw on the jar in the old account and the move's departure is re-settled, as a correction
/// of an existing entry is (P51). The same holds for an existing payment there re-split or re-dated
/// within that stretch (R3-P3-4) or put back on the jar's line (K3). A payment on the jar's line
/// from the new account dated before the move stays refused (his other answer, P2-20).
/// </summary>
public class JarMoveAcceptAndSettleTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly August = new(2026, 8, 1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-r2-d1-{Guid.NewGuid()}")
            .Options);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m, TargetDate = new DateOnly(Today.Year + 1, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A budget month with the jar's Savings line and an Eating out line; returns (jar line, Eating out).</summary>
    private static (BudgetItem Jar, BudgetItem EatingOut) SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar)
    {
        var jarLine = new BudgetItem { Name = jar.Name, PlannedAmount = 100m, SavingsId = jar.Id };
        var eatingOut = new BudgetItem { Name = "Eating out", PlannedAmount = 200m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { jarLine } },
                new() { Name = "Living", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { eatingOut } },
            },
        });
        db.SaveChanges();
        return (jarLine, eatingOut);
    }

    private static UpdateJarCommand MoveTo(Jar jar, Guid accountId) =>
        new(jar.Id, jar.Name, JarKind.Goal, 1200m, jar.TargetDate, AccrualMethod.TargetByDate, accountId);

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid jarId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).BalanceOf(jarId);

    private static async Task<decimal?> UnallocatedAsync(ApplicationDbContext db, Guid accountId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).Accounts[accountId].Unallocated;

    private static async Task<IEnumerable<string>> RefusalAsync(Func<Task> write) =>
        (await write.Should().ThrowAsync<ValidationException>()).Which.Errors.SelectMany(e => e.Value);

    /// <summary>
    /// Holiday held 300 in A from 1 Aug and paid it all on 20 Aug from its line; today it moved to
    /// B. A late 50 payment A made on 10 Aug is what the tests enter.
    /// </summary>
    private sealed record World(ApplicationDbContext Db, Account A, Account B, Jar Jar, BudgetItem Line, BudgetItem EatingOut, Transaction Paid);

    private static async Task<World> MovedAsync(DateOnly? openedA = null)
    {
        var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m, openingDate: openedA);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var (line, eatingOut) = SeedMonth(db, August, jar);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 300m, August);
        var paid = LedgerFixtures.Expense(db, Owner, a.Id, 300m, new DateOnly(2026, 8, 20), line.Id);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        return new World(db, a, b, jar, line, eatingOut, paid);
    }

    private static CreateTransactionCommand LatePayment(World w, Guid accountId, DateOnly? on = null) =>
        new(on ?? new DateOnly(2026, 8, 10), "Travel insurance", 50m, TransactionType.Expense, w.Line.Id, AccountId: accountId);

    /// <summary>A's history carries the late payment on the jar; from the move day A holds nothing of it, and B is untouched.</summary>
    private static async Task ShouldReadTheLatePaymentOnTheJarAsync(World w)
    {
        (await BalanceAsync(w.Db, w.Jar.Id, new DateOnly(2026, 8, 9))).Should().Be(300m);
        (await BalanceAsync(w.Db, w.Jar.Id, new DateOnly(2026, 8, 10))).Should().Be(250m);
        (await BalanceAsync(w.Db, w.Jar.Id, new DateOnly(2026, 8, 20))).Should().Be(-50m);
        (await BalanceAsync(w.Db, w.Jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(w.Db, w.A.Id, new DateOnly(2026, 8, 20))).Should().Be(700m);
        (await UnallocatedAsync(w.Db, w.A.Id, Today)).Should().Be(650m);
        (await UnallocatedAsync(w.Db, w.B.Id, Today)).Should().Be(1000m);
    }

    [Fact]
    public async Task ALatePaymentFromTheOldAccount_DatedBeforeTheMove_DrawsFromTheJarThere_AndTheMoveIsResettled()
    {
        var w = await MovedAsync();
        await using var db = w.Db;

        var late = await new CreateTransactionCommandHandler(db, User).Handle(LatePayment(w, w.A.Id), Ct);

        await ShouldReadTheLatePaymentOnTheJarAsync(w);
        (await new GetJarPaymentsQueryHandler(db, User).Handle(new GetJarPaymentsQuery(w.Jar.Id), Ct))
            .Should().Contain(p => p.Id == late.Id && p.FromJar);

        // Deleting it settles the move back: nothing was left behind in A.
        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(late.Id), Ct);
        (await BalanceAsync(db, w.Jar.Id, new DateOnly(2026, 8, 10))).Should().Be(300m);
        (await BalanceAsync(db, w.Jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, w.A.Id, Today)).Should().Be(700m);
    }

    [Fact]
    public async Task ALatePaymentFromTheOldAccount_OnItsMoveDay_DrawsFromTheJarThere()
    {
        // The move day belongs to both accounts: A's payments that day were kept at the move.
        var w = await MovedAsync();
        await using var db = w.Db;

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Travel insurance", 50m, TransactionType.Expense, w.Line.Id, AccountId: w.A.Id,
                AcknowledgeCrossMonth: true), Ct);

        (await BalanceAsync(db, w.Jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, w.A.Id, Today)).Should().Be(650m);
    }

    [Fact]
    public async Task ALatePaymentOnTheOldAccountsStatement_IsImportedOntoTheJarsLine_AndTheMoveIsResettled()
    {
        var w = await MovedAsync();
        await using var db = w.Db;

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(w.A.Id, new[]
        {
            new CommitImportItem("L1", new DateOnly(2026, 8, 10), "TRAVEL INSURANCE", 50m, "EUR", IsCredit: false, w.Line.Id, null),
        }), Ct);

        result.Imported.Should().Be(1);
        await ShouldReadTheLatePaymentOnTheJarAsync(w);
    }

    [Fact]
    public async Task APaymentOnTheJarsLineDatedAfterTheMove_FromTheOldAccount_IsStillRefused()
    {
        var w = await MovedAsync();
        await using var db = w.Db;

        var messages = await RefusalAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            LatePayment(w, w.A.Id, Today.AddDays(1)) with { AcknowledgeCrossMonth = true }, Ct));

        messages.Should().ContainSingle().Which.Should().Contain("whose money is held in B").And.Contain("Record this payment from B");
    }

    [Fact]
    public async Task APaymentDatedBeforeTheMove_FromAnotherAccount_IsRefused()
    {
        // From B it stays refused (Christopher's "Refuse", P2-20), and so from C. A's stretch is
        // the jar's first recorded one, so where it began isn't known: A isn't named.
        var w = await MovedAsync();
        await using var db = w.Db;
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 1000m, order: 2);
        var create = new CreateTransactionCommandHandler(db, User);

        (await RefusalAsync(() => create.Handle(LatePayment(w, w.B.Id), Ct))).Should().ContainSingle()
            .Which.Should().Contain("A payment on its line from B can't be dated before then");
        (await RefusalAsync(() => create.Handle(LatePayment(w, c.Id), Ct))).Should().ContainSingle()
            .Which.Should().Contain("goes on its line only from the account that held the jar that day").And.NotContain("from A");
        (await BalanceAsync(db, w.Jar.Id, Today)).Should().Be(0m);
    }

    [Fact]
    public async Task R3_P3_4_AKeptPaymentInTheOldAccount_CanBeResplitKeepingItsJarSlice_AndRedatedAcrossAMonth()
    {
        // Holiday held 350 in A from 1 Aug; it paid 150 on 28 Aug and 200 on 30 Aug. Today it moved
        // to B. Re-splitting the 150 as 100 Holiday + 50 Eating out, and re-dating the 200 into
        // September (acknowledged), are corrections P51 accepts.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var (line, eatingOut) = SeedMonth(db, August, jar);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 350m, August);
        var flights = LedgerFixtures.Expense(db, Owner, a.Id, 150m, new DateOnly(2026, 8, 28), line.Id);
        var hotel = LedgerFixtures.Expense(db, Owner, a.Id, 200m, new DateOnly(2026, 8, 30), line.Id);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);

        await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(flights.Id, new[]
        {
            new SplitAllocationInput(line.Id, 100m), new SplitAllocationInput(eatingOut.Id, 50m),
        }), Ct);
        await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            hotel.Id, new DateOnly(2026, 9, 2), "Hotel", 200m, TransactionType.Expense, a.Id, AcknowledgeCrossMonth: true), Ct);

        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 28))).Should().Be(250m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 31))).Should().Be(250m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 9, 2))).Should().Be(50m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, a.Id, Today)).Should().Be(650m);
    }

    [Fact]
    public async Task K3_AKeptPaymentPutOnAnotherLine_CanBePutBackOnTheJarsLine()
    {
        var w = await MovedAsync();
        await using var db = w.Db;
        var assign = new AssignTransactionCommandHandler(db, User);

        await assign.Handle(new AssignTransactionCommand(w.Paid.Id, w.EatingOut.Id), Ct);
        (await BalanceAsync(db, w.Jar.Id, new DateOnly(2026, 8, 20))).Should().Be(300m);
        (await UnallocatedAsync(db, w.A.Id, Today)).Should().Be(700m);

        await assign.Handle(new AssignTransactionCommand(w.Paid.Id, w.Line.Id), Ct);
        (await BalanceAsync(db, w.Jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
        (await BalanceAsync(db, w.Jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, w.A.Id, Today)).Should().Be(700m);
    }

    [Fact]
    public async Task ALatePaymentFromAnOldAccountWithNoOpeningDate_IsRefused_UntilItHasOne()
    {
        // Its ledger reads nothing yet, so the payment couldn't be settled against the move.
        var w = await MovedAsync();
        await using var db = w.Db;
        w.A.OpeningDate = null;
        await db.SaveChangesAsync(Ct);

        var messages = await RefusalAsync(() => new CreateTransactionCommandHandler(db, User).Handle(LatePayment(w, w.A.Id), Ct));

        messages.Should().ContainSingle().Which.Should().Contain("A has no opening date yet").And.Contain("Set A's opening date first");
        (await db.JarAllocations.CountAsync(a => a.Kind == JarAllocationKind.Departure && a.Postings.Any(p => p.Amount != 0m))).Should().Be(0);
    }

    [Fact]
    public async Task ALatePaymentDatedBeforeTheOldAccountOpened_IsAccepted_AndCountsNowhere()
    {
        // A's ledger starts on 1 Aug, so a payment dated 20 Jul is outside every jar figure, as any
        // entry before an account's opening date is: nothing is stored, and the move stays as it was.
        var w = await MovedAsync(openedA: August);
        await using var db = w.Db;
        var (july, _) = SeedMonth(db, new DateOnly(2026, 7, 1), w.Jar);

        var late = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 7, 20), "Travel insurance", 50m, TransactionType.Expense, july.Id, AccountId: w.A.Id), Ct);

        (await db.JarAllocations.AnyAsync(a => a.TransactionId == late.Id)).Should().BeFalse();
        (await BalanceAsync(db, w.Jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
        (await UnallocatedAsync(db, w.A.Id, Today)).Should().Be(700m);
    }

    /// <summary>
    /// Records that <paramref name="jar"/> left each account on the given day, in that order, and
    /// designates it in <paramref name="now"/> from today.
    /// </summary>
    private static async Task DepartedAsync(ApplicationDbContext db, Jar jar, Account now, params (Account From, DateOnly On)[] departures)
    {
        jar.FundingAccountId = now.Id;
        jar.FundingAccountSince = Today;
        foreach (var (from, on) in departures)
        {
            db.JarAllocations.Add(new JarAllocation
            {
                OwnerId = Owner, AccountId = from.Id, Kind = JarAllocationKind.Departure, Date = on, CreatedUtc = DateTime.UtcNow,
                Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = 0m }, new() { JarId = null, Amount = 0m } },
            });
        }
        await db.SaveChangesAsync(Ct);
    }

    [Fact]
    public async Task AStretchBeginsOnThePreviousMove_SoAPaymentDatedBeforeTheJarArrived_IsRefused_NamingWhereItWas()
    {
        // Recorded departures: Holiday left Y on 1 Jul (into X), X on 1 Aug (into A) and A today
        // (into B). A payment from A dated 20 Jul was made while X held the jar; one dated 1 Aug,
        // the day it arrived, or later was A's.
        await using var db = NewContext();
        var y = LedgerFixtures.SeedAccount(db, Owner, "Y", opening: 1000m, order: 3);
        var x = LedgerFixtures.SeedAccount(db, Owner, "X", opening: 1000m, order: 2);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, b);
        var (july, _) = SeedMonth(db, new DateOnly(2026, 7, 1), jar);
        var (line, _) = SeedMonth(db, August, jar);
        await DepartedAsync(db, jar, b, (y, new DateOnly(2026, 7, 1)), (x, August), (a, Today));
        var create = new CreateTransactionCommandHandler(db, User);

        var messages = await RefusalAsync(() => create.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 7, 20), "Travel agent", 50m, TransactionType.Expense, july.Id, AccountId: a.Id), Ct));
        messages.Should().ContainSingle().Which.Should().Contain("which was held in X on 20 Jul 2026").And.Contain("Record this payment from X");

        await create.Handle(new CreateTransactionCommand(August, "Travel agent", 50m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        (await BalanceAsync(db, jar.Id, August)).Should().Be(-50m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, a.Id, Today)).Should().Be(950m);
    }

    [Fact]
    public async Task P2_1_AKeptPayment_RedatedWithinItsMonth_ToBeforeTheJarArrived_IsRefused()
    {
        // Holiday left X on 10 Aug (into A) and A today (into B). A's 20 Aug payment on its line is
        // kept on the jar; re-dated to 5 Aug, while X held the jar, it is refused as it would be
        // entered, and it can still move to 10 Aug, the day the jar arrived.
        await using var db = NewContext();
        var x = LedgerFixtures.SeedAccount(db, Owner, "X", opening: 1000m, order: 2);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, b);
        var (line, _) = SeedMonth(db, August, jar);
        await DepartedAsync(db, jar, b, (x, new DateOnly(2026, 8, 10)), (a, Today));
        var late = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 20), "Travel agent", 50m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct);
        UpdateTransactionCommand Redate(int day) => new(late.Id, new DateOnly(2026, 8, day), "Travel agent", 50m, TransactionType.Expense, a.Id);

        var messages = await RefusalAsync(() => new UpdateTransactionCommandHandler(db, User).Handle(Redate(5), Ct));

        messages.Should().ContainSingle().Which.Should().Contain("another account held Holiday until 10 Aug 2026");
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 7))).Should().Be(0m);
        await new UpdateTransactionCommandHandler(db, User).Handle(Redate(10), Ct);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 10))).Should().Be(-50m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await UnallocatedAsync(db, a.Id, Today)).Should().Be(950m);
    }

    [Fact]
    public async Task P3_1_TheRefusalDoesNotNameAnAccount_WhoseStretchMayHaveBegunLater()
    {
        // Holiday was in A with nothing in it until 10 Aug and moved to B (no departure: A carried
        // nothing), then left B today (into C). B's stretch has no recorded start, so a payment
        // from A dated 5 Aug isn't sent to B.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 1000m, order: 2);
        var jar = SeedGoal(db, c);
        var (line, _) = SeedMonth(db, August, jar);
        await DepartedAsync(db, jar, c, (b, Today));

        var messages = await RefusalAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 8, 5), "Travel agent", 50m, TransactionType.Expense, line.Id, AccountId: a.Id), Ct));

        messages.Should().ContainSingle().Which.Should().Contain("goes on its line only from the account that held the jar that day")
            .And.NotContain("held in B");
    }

    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);

    private static async Task<(decimal InA, decimal? Unallocated)> ReadAAsync(ApplicationDbContext db, Account a, Jar jar, DateOnly asOf)
    {
        var read = (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).Accounts[a.Id];
        return (read.JarBalances!.GetValueOrDefault(jar.Id), read.Unallocated);
    }

    [Fact]
    public async Task AReturnDatedBeforeTheMove_RecordedAfterIt_GoesBackToTheJar_AndTheMoveIsResettled()
    {
        // Holiday 400 in A paid a 100 transfer to B on 10 Sep; Holiday was emptied on 15 Sep and
        // moved to C today. The transfer bounced on 12 Sep, marked after the move: the money went
        // back to Holiday while A held it, and leaves A's Holiday on the move day (W07 returns follow R2-D1).
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, order: 2);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: jar.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -300m, new DateOnly(2026, 9, 15), JarAllocationKind.Reallocation);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, c.Id), Ct);

        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Sep12), Ct);

        (await ReadAAsync(db, a, jar, Sep12)).Should().Be((400m, (decimal?)600m));
        (await ReadAAsync(db, a, jar, new DateOnly(2026, 9, 15))).Should().Be((100m, (decimal?)900m));
        (await ReadAAsync(db, a, jar, Today)).Should().Be((0m, (decimal?)1000m));
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
    }

    [Fact]
    public async Task AReturnInAnEarlierStretch_OfAJarThatCameBack_GoesBackToTheJar()
    {
        // Holiday 100 in A paid a 100 transfer to B on 10 Sep, then moved to C and back to A today.
        // The bounce of 12 Sep, marked now, falls in its first stretch in A (the reviewer's probe
        // M3_AReturnInAnEarlierStretch_OfAJarThatCameBack on #279, which gave the jar nothing).
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, order: 2);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: jar.Id), Ct);
        foreach (var to in new[] { c.Id, a.Id })
        {
            await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, to), Ct);
        }

        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: jar.Id), Ct);

        (await ReadAAsync(db, a, jar, Sep12)).Should().Be((100m, (decimal?)900m));
        (await ReadAAsync(db, a, jar, Today)).Should().Be((0m, (decimal?)1000m));
    }

    [Fact]
    public async Task AKeptReturn_RedatedToWhileTheJarWasAway_IsRefused()
    {
        // Holiday 100 in A paid a 100 transfer to B on 10 Sep. Holiday left A on 13 Sep and came
        // back on 20 Sep. The transfer bounced: marked returned on 21 Sep, the money goes back to
        // Holiday; re-dated to 15 Sep, while C held Holiday, it is refused.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, order: 2);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: jar.Id), Ct);
        foreach (var to in new[] { c.Id, a.Id })
        {
            await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, to), Ct);
        }
        (await db.JarAllocations.SingleAsync(x => x.Kind == JarAllocationKind.Departure)).Date = new DateOnly(2026, 9, 13);
        jar.FundingAccountSince = new DateOnly(2026, 9, 20);
        await db.SaveChangesAsync(Ct);
        UpdateTransferCommand ReturnedOn(int day) => new(transfer.Id, a.Id, b.Id, 100m, Sep10, null, new DateOnly(2026, 9, day), FromJarId: jar.Id);

        await new UpdateTransferCommandHandler(db, User).Handle(ReturnedOn(21), Ct);
        (await ReadAAsync(db, a, jar, new DateOnly(2026, 9, 21))).Should().Be((100m, (decimal?)900m));

        var messages = await RefusalAsync(() => new UpdateTransferCommandHandler(db, User).Handle(ReturnedOn(15), Ct));
        messages.Should().ContainSingle().Which.Should().Contain("another account held Holiday until 20 Sep 2026");
    }

    [Fact]
    public async Task ATransferAndItsFee_DatedByTheStatementAfterTheJarLeft_NoLongerDrawFromItThere()
    {
        // Holiday 400 in A paid a 100 transfer to B and its 2 fee (on Holiday's line) on 10 Sep,
        // was emptied on 12 Sep and left A on 13 Sep. A's statement says the money left on 15 Sep:
        // both now draw from A's unallocated money, and Holiday held the 102 until it left.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, order: 2);
        var jar = SeedGoal(db, a);
        var (line, _) = SeedMonth(db, Sep1, jar);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: jar.Id, Fee: 2m, FeeBudgetItemId: line.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -298m, Sep12, JarAllocationKind.Reallocation);
        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, c.Id), Ct);
        (await db.JarAllocations.SingleAsync(x => x.Kind == JarAllocationKind.Departure)).Date = new DateOnly(2026, 9, 13);
        await db.SaveChangesAsync(Ct);

        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem("TRF-1", new DateOnly(2026, 9, 15), "To B", 102m, "EUR", false, null, null,
                TransferAccountId: b.Id, MatchTransferId: transfer.Id),
        }), Ct);

        (await ReadAAsync(db, a, jar, Sep12)).Should().Be((102m, (decimal?)898m));
        (await ReadAAsync(db, a, jar, new DateOnly(2026, 9, 14))).Should().Be((0m, (decimal?)1000m));
        (await ReadAAsync(db, a, jar, Today)).Should().Be((0m, (decimal?)898m));
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
    }
}
