using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rules 68, 70 and 77 across history (app-2026-09-30 review JL-P1-1, JL-P1-2, JL-P2-3, JL-P2-4):
/// money moved out of a jar or out of unallocated funds as of a past date stays moved on every
/// later date, so the source must still hold it after what it paid or moved out since, and no
/// later day may be left with positive jars the account's money does not back. A deficit a
/// payment caused stays readable (rule 70) and does not block a move that leaves it as it is.
/// </summary>
public class JarHistoryChecksTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Jan1 = new(2026, 1, 1);
    private static readonly DateOnly Jan2 = new(2026, 1, 2);
    private static readonly DateOnly Jan15 = new(2026, 1, 15);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m,
            TargetDate = new DateOnly(Today.Year + 1, 7, 1), Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static async Task<JarLedgerView> TodayAsync(ApplicationDbContext db, Guid accountId) =>
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[accountId];

    private static Task PayFromJarAsync(ApplicationDbContext db, Account account, Jar jar, decimal amount, DateOnly date) =>
        new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(date, "Hotel", amount, TransactionType.Expense, null, account.Id, PaidFromJarId: jar.Id), Ct);

    private static string Message(ValidationException ex, string key) => string.Join(" ", ex.Errors[key]);

    // --- Reallocation (JL-P1-1) ------------------------------------------------------------------

    [Fact]
    public async Task BackDatedReallocation_OfMoneyTheSourceSpentSince_IsRefusedNamingTheDayItRunsShort()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 100m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        var car = SeedGoal(db, savings, "Car");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 100m, Jan1);
        await PayFromJarAsync(db, savings, holiday, 100m, Jan15);

        // On 2 January Holiday still held 100, so a check of that day alone passed.
        var act = () => new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 100m, Jan2), Ct);

        var refusal = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(refusal, "Amount").Should().Contain("Holiday holds 0 on 2026-01-15").And.Contain("as of 2026-01-02");
        (await db.JarAllocations.CountAsync(a => a.Kind == JarAllocationKind.Reallocation)).Should().Be(0);
        var today = await TodayAsync(db, savings.Id);
        today.JarBalances[holiday.Id].Should().Be(0m);
        today.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task BackDatedReallocation_TheSourceStillCovers_IsAcceptedAndCountsFromItsDate()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 100m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        var car = SeedGoal(db, savings, "Car");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 100m, Jan1);
        await PayFromJarAsync(db, savings, holiday, 40m, Jan15);

        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 60m, Jan2), Ct);

        var today = await TodayAsync(db, savings.Id);
        today.JarBalances[holiday.Id].Should().Be(0m);
        today.JarBalances[car.Id].Should().Be(60m);
        today.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task BackDatedReallocation_ALaterDeficitAPaymentCaused_DoesNotBlockAMoveThatLeavesItAsItIs()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 100m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        var car = SeedGoal(db, savings, "Car");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 50m, Jan1);
        LedgerFixtures.Allocate(db, Owner, savings.Id, car.Id, 50m, Jan1);
        // A payment on no line draws from unallocated (rule 79): from 15 January the jars hold 100 of 70.
        LedgerFixtures.Expense(db, Owner, savings.Id, 30m, Jan15);
        (await TodayAsync(db, savings.Id)).HasBackingDeficit.Should().BeTrue();

        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 20m, Jan2), Ct);

        var today = await TodayAsync(db, savings.Id);
        today.JarBalances[holiday.Id].Should().Be(30m);
        today.JarBalances[car.Id].Should().Be(70m);
        today.PositiveAllocations.Should().Be(100m, "the move neither caused nor grew the deficit");
    }

    [Fact]
    public async Task ReallocationToday_OfMoneyAFutureDatedPaymentTakes_IsRefused()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 100m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        var car = SeedGoal(db, savings, "Car");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 100m, Jan1);
        await PayFromJarAsync(db, savings, holiday, 100m, Today.AddDays(5));

        var act = () => new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 100m), Ct);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Amount");
    }

    // --- Money already set aside (JL-P1-2) -------------------------------------------------------

    [Fact]
    public async Task BackDatedInitialAllocation_OfMoneyTheAccountSpentSince_IsRefused()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 500m, Jan1);
        SeedGoal(db, savings, "Other");
        LedgerFixtures.Expense(db, Owner, savings.Id, 500m, Jan15);

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1200m, new DateOnly(Today.Year + 1, 7, 1), AccrualMethod.TargetByDate, savings.Id,
            InitialAllocation: 500m, InitialAllocationDate: Jan2), Ct);

        var refusal = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(refusal, "InitialAllocation").Should().Contain("holds 0 on 2026-01-15");
        (await db.Jars.AnyAsync(j => j.Name == "Holiday")).Should().BeFalse("a refused jar is never saved without the money it claimed");
    }

    [Fact]
    public async Task BackDatedInitialAllocation_OnAnAccountThatBacksNoJarYet_IsCheckedTheSameWay()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 50m, Jan1);
        LedgerFixtures.Expense(db, Owner, savings.Id, 50m, Jan15);

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Bike", JarKind.Goal, 300m, new DateOnly(Today.Year + 1, 7, 1), AccrualMethod.TargetByDate, savings.Id,
            InitialAllocation: 50m, InitialAllocationDate: Jan2), Ct);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("InitialAllocation");
    }

    [Fact]
    public async Task BackDatedInitialAllocation_TheMoneyIsStillThere_IsAccepted()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 500m, Jan1);
        LedgerFixtures.Expense(db, Owner, savings.Id, 200m, Jan15);

        var dto = await new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1200m, new DateOnly(Today.Year + 1, 7, 1), AccrualMethod.TargetByDate, savings.Id,
            InitialAllocation: 300m, InitialAllocationDate: Jan2), Ct);

        var today = await TodayAsync(db, savings.Id);
        today.JarBalances[dto.Id].Should().Be(300m);
        today.Unallocated.Should().Be(0m);
    }

    // --- Transfers "from a jar" (JL-P2-3) --------------------------------------------------------

    private static (Account A, Account B, Jar Holiday, Jar Repairs, Jar Car) SeedTwoAccounts(ApplicationDbContext db)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Jan1);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Jan1, order: 1);
        var holiday = SeedGoal(db, a, "Holiday");
        var repairs = SeedGoal(db, a, "Repairs");
        var car = SeedGoal(db, b, "Car");
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 100m, Jan1);
        LedgerFixtures.Allocate(db, Owner, a.Id, repairs.Id, 900m, Jan1);
        return (a, b, holiday, repairs, car);
    }

    [Fact]
    public async Task TransferFromAJar_LargerThanTheJarHolds_IsRefused_Rule68()
    {
        await using var db = NewContext();
        var (a, b, holiday, _, car) = SeedTwoAccounts(db);

        var act = () => new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Today, 500m, a.Id, b.Id, ReceivedOn: Today, FromJarId: holiday.Id,
                JarAllocations: new[] { new JarAllocationInput(car.Id, 500m) }), Ct);

        var refusal = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(refusal, "FromJarId").Should().Contain("Holiday holds 100");
        (await db.Transactions.AnyAsync(t => t.Type == TransactionType.Transfer)).Should().BeFalse();
    }

    [Fact]
    public async Task TransferFromAJar_WithinWhatItHolds_MovesTheMoney()
    {
        await using var db = NewContext();
        var (a, b, holiday, repairs, car) = SeedTwoAccounts(db);

        await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Today, 100m, a.Id, b.Id, ReceivedOn: Today, FromJarId: holiday.Id,
                JarAllocations: new[] { new JarAllocationInput(car.Id, 100m) }), Ct);

        var snapshot = await JarLedgerReader.ReadAsync(db, Owner, Today, Ct);
        snapshot.BalanceOf(holiday.Id).Should().Be(0m);
        snapshot.BalanceOf(repairs.Id).Should().Be(900m);
        snapshot.BalanceOf(car.Id).Should().Be(100m);
        snapshot.Accounts[a.Id].HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task TransferFromAJar_ConfirmingADepartureLargerThanTheJarHolds_IsRefused()
    {
        await using var db = NewContext();
        var (a, b, holiday, _, _) = SeedTwoAccounts(db);
        // Receipt-first: the money arrived in B, its departure from A still unknown (rule 72).
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Today, 300m, a.Id, b.Id), Ct);
        var pending = await db.Transactions.SingleAsync(t => t.Id == transfer.Id);
        pending.DepartedOn = null;
        pending.ReceivedOn = Today;
        await db.SaveChangesAsync(Ct);

        var act = () => new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(transfer.Id, DepartedOn: Today, FromJarId: holiday.Id), Ct);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("FromJarId");
    }

    [Fact]
    public async Task EditingATransferFromAJar_OnlyAChangedDrawIsChecked()
    {
        await using var db = NewContext();
        var (a, b, holiday, _, _) = SeedTwoAccounts(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Jan2, 100m, a.Id, b.Id, ReceivedOn: Jan2, FromJarId: holiday.Id), Ct);
        var handler = new UpdateTransferCommandHandler(db, User);

        // A new payee changes no money: accepted.
        await handler.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Jan2, Jan2, Payee: "To B", FromJarId: holiday.Id), Ct);

        // Taking more from the jar than it held is not.
        var act = () => handler.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 150m, Jan2, Jan2, FromJarId: holiday.Id), Ct);
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("FromJarId");
    }

    // --- Opening balance (JL-P2-4) ---------------------------------------------------------------

    [Fact]
    public async Task LoweringTheOpeningBalance_BelowWhatTheJarsHold_IsRefused()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 1000m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 800m, Jan1);

        var act = () => new UpdateAccountCommandHandler(db, User).Handle(
            new UpdateAccountCommand(savings.Id, "Savings", AccountType.Savings, 500m, Jan1), Ct);

        var refusal = (await act.Should().ThrowAsync<ValidationException>()).Which;
        Message(refusal, "OpeningBalance").Should().Contain("would hold 500").And.Contain("jars hold 800");
        (await db.Accounts.AsNoTracking().SingleAsync(x => x.Id == savings.Id)).OpeningBalance.Should().Be(1000m);
    }

    [Theory]
    [InlineData(800)]
    [InlineData(1200)]
    public async Task ChangingTheOpeningBalance_WhileTheJarsStayBacked_IsAccepted(int opening)
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 1000m, Jan1);
        var holiday = SeedGoal(db, savings, "Holiday");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 800m, Jan1);

        await new UpdateAccountCommandHandler(db, User).Handle(
            new UpdateAccountCommand(savings.Id, "Savings", AccountType.Savings, opening, Jan1), Ct);

        var today = await TodayAsync(db, savings.Id);
        today.AccountBalance.Should().Be(opening);
        today.HasBackingDeficit.Should().BeFalse();
    }
}
