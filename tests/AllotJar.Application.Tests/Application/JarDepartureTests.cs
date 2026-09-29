using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rule 80's kept history, balanced (W05 re-review P2-9, P2-10, P2-11): a jar that left an account
/// holds nothing there from the day it left; a correction to a pre-move leg changes the dates
/// before the move (rule 49) and is settled on the departure; every reader and zero check reads
/// one balance.
/// </summary>
public class JarDepartureTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Aug1 = new(2026, 8, 1);
    private static readonly DateOnly Aug10 = new(2026, 8, 10);
    private static readonly DateOnly Aug15 = new(2026, 8, 15);
    private static readonly DateOnly Aug19 = new(2026, 8, 19);
    private static readonly DateOnly Aug20 = new(2026, 8, 20);
    private static readonly DateOnly Aug25 = new(2026, 8, 25);
    private static readonly DateOnly Aug31 = new(2026, 8, 31);
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep5 = new(2026, 9, 5);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static DateOnly Deadline => new(Today.Year + 1, 7, 1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-departure-{Guid.NewGuid()}")
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

    /// <summary>August 2026: a Savings line per jar, a Groceries line and a Salary line.</summary>
    private static (Dictionary<Guid, BudgetItem> JarLines, BudgetItem Groceries) SeedAugust(ApplicationDbContext db, params Jar[] jars)
    {
        var jarLines = jars.ToDictionary(j => j.Id, j => new BudgetItem { Name = j.Name, SavingsId = j.Id, PlannedAmount = 100m });
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 8, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = jarLines.Values.ToList() },
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries } },
            },
        });
        db.SaveChanges();
        return (jarLines, groceries);
    }

    /// <summary>What UpdateJar does on an account change, on a chosen day (the handler uses the real clock).</summary>
    private static async Task MoveAsync(ApplicationDbContext db, Jar jar, Account to, DateOnly on)
    {
        var kept = await JarMovements.KeepLineAttributionAsync(db, Owner, jar, on, Ct);
        await JarDepartures.RecordAsync(db, Owner, jar.Id, jar.FundingAccountId, on, kept > 0, Ct);
        jar.FundingAccountId = to.Id;
        await db.SaveChangesAsync(Ct);
    }

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid jarId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).BalanceOf(jarId);

    private static async Task<JarLedgerView> ViewAsync(ApplicationDbContext db, Guid accountId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).Accounts[accountId];

    private static Task<JarAllocation> DepartureAsync(ApplicationDbContext db, Guid accountId) =>
        db.JarAllocations.AsNoTracking().Include(a => a.Postings)
            .SingleAsync(a => a.AccountId == accountId && a.Kind == JarAllocationKind.Departure);

    /// <summary>The invariant: a jar holds nothing in an account it left, on the day it left and every day after.</summary>
    private static async Task AssertDepartedJarsHoldNothingAsync(ApplicationDbContext db)
    {
        var jars = await db.Jars.AsNoTracking().ToDictionaryAsync(j => j.Id);
        var departures = await db.JarAllocations.AsNoTracking().Include(a => a.Postings)
            .Where(a => a.Kind == JarAllocationKind.Departure).ToListAsync();
        foreach (var departure in departures)
        {
            var jarId = departure.Postings.Single(p => p.JarId is not null).JarId!.Value;
            if (jars[jarId].FundingAccountId == departure.AccountId)
            {
                continue;
            }
            foreach (var date in new[] { departure.Date, Today })
            {
                (await ViewAsync(db, departure.AccountId, date)).JarBalances.GetValueOrDefault(jarId)
                    .Should().Be(0m, $"the jar left the account on {departure.Date}");
            }
        }
    }

    /// <summary>A 1,000, B 1,000; Holiday in A gets 100 on 1 Aug, its line pays 100 from A on 20 Aug, and it moves to B on 1 Sep.</summary>
    private static async Task<(Account A, Account B, Jar Jar, Transaction Payment, BudgetItem Groceries)> KeptPaymentAsync(
        ApplicationDbContext db, DateOnly? movedOn = null)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Aug1);
        var (lines, groceries) = SeedAugust(db, jar);
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 100m, Aug20, lines[jar.Id].Id);
        await MoveAsync(db, jar, b, movedOn ?? Sep1);
        return (a, b, jar, payment, groceries);
    }

    [Fact]
    public async Task Rule80_CorrectingAKeptPayment_SettlesTheDifference_OnTheDayTheJarLeft()
    {
        await using var db = NewContext();
        var (a, _, jar, payment, _) = await KeptPaymentAsync(db);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(payment.Id, Aug20, "Shop", 80m, TransactionType.Expense, a.Id), Ct);

        // Before the payment, between the payment and the move, from the move on.
        (await BalanceAsync(db, jar.Id, Aug19)).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, Aug31)).Should().Be(20m, "the corrected history: it held 100 and spent 80 (rule 49)");
        (await BalanceAsync(db, jar.Id, Sep1)).Should().Be(0m, "a jar holds nothing in an account it left (rule 2)");
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((920m, 20m, 900m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((920m, 0m, 920m));
        var departure = await DepartureAsync(db, a.Id);
        departure.Date.Should().Be(Sep1);
        departure.Postings.Single(p => p.JarId == jar.Id).Amount.Should().Be(-20m);
        departure.Postings.Single(p => p.JarId == null).Amount.Should().Be(20m);

        // The zero check and the card read the same figure: archiving is allowed and shows 0.
        var archived = await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
        archived.CurrentBalance.Should().Be(0m);
        (await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(IncludeArchived: true), Ct))
            .Single().CurrentBalance.Should().Be(0m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_DeletingAKeptPayment_SettlesIt_OnTheDayTheJarLeft()
    {
        await using var db = NewContext();
        var (a, _, jar, payment, _) = await KeptPaymentAsync(db);

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(payment.Id), Ct);

        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((1000m, 100m, 900m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((1000m, 0m, 1000m));
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_MovingAKeptPaymentOffTheJarsLine_SettlesIt()
    {
        await using var db = NewContext();
        var (a, _, jar, payment, groceries) = await KeptPaymentAsync(db);

        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(payment.Id, groceries.Id), Ct);

        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((900m, 100m, 800m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((900m, 0m, 900m));
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_AKeptPayment_CanMoveWithinTheStretch_ButNotPastTheDayTheJarLeft()
    {
        await using var db = NewContext();
        var (a, _, jar, payment, _) = await KeptPaymentAsync(db, movedOn: Aug25);
        var update = new UpdateTransactionCommandHandler(db, User);

        await update.Handle(new UpdateTransactionCommand(payment.Id, new DateOnly(2026, 8, 22), "Shop", 100m, TransactionType.Expense, a.Id), Ct);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 21))).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 22))).Should().Be(0m);
        (await DepartureAsync(db, a.Id)).Postings.Should().OnlyContain(p => p.Amount == 0m);

        var act = () => update.Handle(new UpdateTransactionCommand(payment.Id, new DateOnly(2026, 8, 28), "Shop", 100m, TransactionType.Expense, a.Id), Ct);
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Date");
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == payment.Id)).Date.Should().Be(new DateOnly(2026, 8, 22));
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    /// <summary>A 1,000, B 1,000; 300 income into A on 10 Aug put into Holiday; its line pays 300 on 20 Aug; moved to B on 1 Sep; 300 of B's money into it on 5 Sep.</summary>
    private static async Task<(Account A, Account B, Jar Jar, Guid IncomeId)> KeptIncomeAsync(ApplicationDbContext db)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var (lines, _) = SeedAugust(db, jar);
        var income = await new CreateTransactionCommandHandler(db, User).Handle(new CreateTransactionCommand(
            Aug10, "Employer", 300m, TransactionType.Income, null, a.Id, JarAllocations: new[] { new JarAllocationInput(jar.Id, 300m) }), Ct);
        LedgerFixtures.Expense(db, Owner, a.Id, 300m, Aug20, lines[jar.Id].Id);
        await MoveAsync(db, jar, b, Sep1);
        LedgerFixtures.Allocate(db, Owner, b.Id, jar.Id, 300m, Sep5, JarAllocationKind.Reallocation);
        return (a, b, jar, income.Id);
    }

    [Fact]
    public async Task Rule80_APayeeEditOfAKeptIncome_KeepsItsJarShare()
    {
        await using var db = NewContext();
        var (a, _, jar, incomeId) = await KeptIncomeAsync(db);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(300m);

        // The old account backs no jar now, so the edit form sends no jar answer.
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(incomeId, Aug10, "Employer Ltd", 300m, TransactionType.Income, a.Id), Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(300m);
        (await BalanceAsync(db, jar.Id, Aug15)).Should().Be(300m);
        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((1000m, 0m, 1000m));
        (await DepartureAsync(db, a.Id)).Postings.Should().OnlyContain(p => p.Amount == 0m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_AnEditEchoingAKeptIncomeShare_IsAccepted_WhileTheOldAccountBacksAnotherJar()
    {
        await using var db = NewContext();
        var (a, _, jar, incomeId) = await KeptIncomeAsync(db);
        SeedGoal(db, a, "Car");

        await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            incomeId, Aug10, "Employer Ltd", 300m, TransactionType.Income, a.Id,
            JarAllocations: new[] { new JarAllocationInput(jar.Id, 300m) }), Ct);

        (await BalanceAsync(db, jar.Id, Aug15)).Should().Be(300m);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(300m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_CorrectingAKeptIncomesAmount_KeepsTheShareWhileItFits_AndSettlesWhatNoLongerFits()
    {
        await using var db = NewContext();
        var (a, _, jar, incomeId) = await KeptIncomeAsync(db);
        var update = new UpdateTransactionCommandHandler(db, User);

        await update.Handle(new UpdateTransactionCommand(incomeId, Aug10, "Employer", 400m, TransactionType.Income, a.Id), Ct);
        var larger = await ViewAsync(db, a.Id, Aug15);
        (larger.JarBalances[jar.Id], larger.Unallocated).Should().Be((300m, 1100m));
        (await DepartureAsync(db, a.Id)).Postings.Should().OnlyContain(p => p.Amount == 0m);

        await update.Handle(new UpdateTransactionCommand(incomeId, Aug10, "Employer", 250m, TransactionType.Income, a.Id), Ct);
        var smaller = await ViewAsync(db, a.Id, Aug15);
        (smaller.JarBalances[jar.Id], smaller.Unallocated).Should().Be((250m, 1000m));
        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((950m, -50m, 1000m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((950m, 0m, 950m));
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(300m, "B's 300 is untouched");
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_MovingAKeptIncomeToAnotherAccount_SettlesItsShare()
    {
        await using var db = NewContext();
        var (a, _, jar, incomeId) = await KeptIncomeAsync(db);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", opening: 0m, order: 2);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(incomeId, Aug10, "Employer", 300m, TransactionType.Income, c.Id), Ct);

        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((700m, -300m, 1000m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((700m, 0m, 700m));
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(300m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task UpdateJar_RecordsTheDayTheJarLeft_OnlyWhereItLeavesHistory()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var used = SeedGoal(db, a);
        var unused = SeedGoal(db, a, "Car");
        LedgerFixtures.Allocate(db, Owner, a.Id, used.Id, 100m, Aug1);
        LedgerFixtures.Allocate(db, Owner, a.Id, used.Id, -100m, Aug15, JarAllocationKind.Reallocation);
        var handler = new UpdateJarCommandHandler(db, User);

        await handler.Handle(new UpdateJarCommand(used.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        var card = await handler.Handle(new UpdateJarCommand(unused.Id, "Car", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);

        var departure = await DepartureAsync(db, a.Id);
        departure.Date.Should().Be(Today);
        departure.Postings.Select(p => (p.JarId, p.Amount)).Should().BeEquivalentTo(new (Guid?, decimal)[] { (used.Id, 0m), (null, 0m) });
        card.CanDelete.Should().BeTrue("a jar that never held money leaves no departure behind (rule 84)");
    }

    [Fact]
    public async Task UpdateJar_IsRefused_WhileATransferIntoTheJarHasNotArrived()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(
            Aug10, 50m, b.Id, a.Id, JarAllocations: new[] { new JarAllocationInput(jar.Id, 50m) }), Ct);

        var act = () => new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            jar.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("FundingAccountId");
        (await db.Jars.AsNoTracking().SingleAsync()).FundingAccountId.Should().Be(a.Id);
    }

    [Fact]
    public async Task UpdateJar_IsRefused_WhileTheOldAccountHasAJarEntryDatedAfterToday()
    {
        // Round 4 P2-18: a 200 income dated three days ahead is split into Holiday in A. Holiday
        // holds 0 today, but moving it would leave A holding the 200 for it from payday, with no
        // departure to settle it. The move waits until that entry no longer names the jar.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var payday = Today.AddDays(3);
        var income = await new CreateTransactionCommandHandler(db, User).Handle(new CreateTransactionCommand(
            payday, "Employer", 200m, TransactionType.Income, null, a.Id, JarAllocations: new[] { new JarAllocationInput(jar.Id, 200m) }), Ct);
        Task<Jars.Dtos.JarDto> Move() => new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            jar.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);

        var refused = (await FluentActions.Awaiting(Move).Should().ThrowAsync<ValidationException>()).Which;
        refused.Errors["FundingAccountId"].Single().Should().Be(
            $"Holiday has an entry dated {payday:d MMM yyyy} in A. Change or remove it first, then change the account.");
        (await db.Jars.AsNoTracking().SingleAsync()).FundingAccountId.Should().Be(a.Id);

        // A payee edit keeps the split, so the move still waits; an edit that leaves the income
        // unallocated lets it go, and the jar holds nothing on payday.
        await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            income.Id, payday, "Employer Ltd", 200m, TransactionType.Income, a.Id, JarAllocations: new[] { new JarAllocationInput(jar.Id, 200m) }), Ct);
        await FluentActions.Awaiting(Move).Should().ThrowAsync<ValidationException>();
        await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            income.Id, payday, "Employer Ltd", 200m, TransactionType.Income, a.Id), Ct);
        await Move();

        (await db.Jars.AsNoTracking().SingleAsync()).FundingAccountId.Should().Be(b.Id);
        (await BalanceAsync(db, jar.Id, payday)).Should().Be(0m);
        (await db.JarAllocations.AnyAsync(al => al.AccountId == a.Id && al.Postings.Any(p => p.JarId == jar.Id)))
            .Should().BeFalse("the income's 200 stays in A's unallocated money");
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_ALegacyMove_WithNoDepartureRecorded_IsSettledOnTheLastDayTheOldLedgerTouchedTheJar()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Aug1);
        var (lines, _) = SeedAugust(db, jar);
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 100m, Aug20, lines[jar.Id].Id);
        await JarMovements.KeepLineAttributionAsync(db, Owner, jar, Sep1, Ct);
        jar.FundingAccountId = b.Id; // moved before departures were recorded
        await db.SaveChangesAsync(Ct);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(payment.Id, Aug20, "Shop", 80m, TransactionType.Expense, a.Id), Ct);

        var departure = await DepartureAsync(db, a.Id);
        departure.Date.Should().Be(Aug20);
        (await BalanceAsync(db, jar.Id, Aug19)).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, Aug20)).Should().Be(0m);
        (await ViewAsync(db, a.Id, Aug31)).Unallocated.Should().Be(920m);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task P2_9_TheCardAWriteReturns_EqualsTheNextRead_AfterAMidMonthMove()
    {
        // The jar entered this month in A and moved to B during it; the write's card and the next
        // GET /jars must read the same ledger (HANDOVER step 3).
        await using var db = NewContext();
        var monthStart = new DateOnly(Today.Year, Today.Month, 1);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 2000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 300m, monthStart.AddDays(-10));
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -300m, monthStart, JarAllocationKind.Reallocation);
        var handler = new UpdateJarCommandHandler(db, User);
        await handler.Handle(new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, b.Id, jar.Id, 300m, Today, JarAllocationKind.Reallocation);

        var card = await handler.Handle(new UpdateJarCommand(jar.Id, "Trip", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        var read = (await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(), Ct)).Single();

        card.Should().BeEquivalentTo(read);
        card.ContributedThisMonth.Should().Be(0m, "it entered the month with 300 in A and holds 300 in B");
        var tracked = await db.Jars.SingleAsync();
        var planned = (await JarPlanner.PlanMonthAsync(db, Owner, new[] { tracked }, Today.Year, Today.Month, Today, Ct))[jar.Id];
        var schedule = await JarPlanner.ScheduleAsync(db, Owner, tracked, Today, 0m, Ct);
        planned.Should().Be(schedule.Months.First().Planned);
    }

    [Fact]
    public async Task P2_9_AJarEmptiedInA_MovedToB_AndGiven50_ReadsTheSame_OnTheCard_TheList_AndThePlan()
    {
        // Christopher's reproduction on 5dbaf02: Holiday entered the month with 300 in A, was emptied
        // there, moved to B and was given 50. The save's card read B alone (50 contributed) while
        // the list read every account (0: it entered the month with 300), and the month's plan
        // differed from the preview (83.33 against 100). One balance: 0 contributed everywhere.
        await using var db = NewContext();
        var monthStart = new DateOnly(Today.Year, Today.Month, 1);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 2000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 300m, monthStart.AddDays(-20));
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -300m, monthStart, JarAllocationKind.Reallocation);
        var handler = new UpdateJarCommandHandler(db, User);
        await handler.Handle(new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(new ReallocateJarMoneyCommand(b.Id, null, jar.Id, 50m, Today), Ct);

        var card = await handler.Handle(new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, b.Id), Ct);
        var read = (await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(), Ct)).Single();

        card.Should().BeEquivalentTo(read);
        (read.CurrentBalance, read.ContributedThisMonth).Should().Be((50m, 0m));
        var tracked = await db.Jars.SingleAsync();
        var planned = (await JarPlanner.PlanMonthAsync(db, Owner, new[] { tracked }, Today.Year, Today.Month, Today, Ct))[jar.Id];
        var schedule = await JarPlanner.ScheduleAsync(db, Owner, tracked, Today, 0m, Ct);
        planned.Should().Be(schedule.Months.First().Planned);
    }

    [Fact]
    public async Task Rule80_APaymentDatedAfterTheMove_IsNotKeptOnTheJar()
    {
        // Holiday is emptied in A on 15 Aug and moves to B on 1 Sep; a payment on its September
        // line from A is dated 10 Sep. On that day the jar was in B, so A's unallocated pays it
        // and the jar still holds nothing in A.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Aug1);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, -100m, Aug15, JarAllocationKind.Reallocation);
        var line = new BudgetItem { Name = "Holiday", SavingsId = jar.Id, PlannedAmount = 100m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
        });
        db.SaveChanges();
        LedgerFixtures.Expense(db, Owner, a.Id, 50m, new DateOnly(2026, 9, 10), line.Id);

        await MoveAsync(db, jar, b, Sep1);

        var after = await ViewAsync(db, a.Id, new DateOnly(2026, 9, 10));
        (after.AccountBalance, after.JarBalances.GetValueOrDefault(jar.Id), after.Unallocated).Should().Be((950m, 0m, 950m));
        (await db.JarAllocations.CountAsync(al => al.AccountId == a.Id && al.TransactionId != null)).Should().Be(0);
        await AssertDepartedJarsHoldNothingAsync(db);
    }

    [Fact]
    public async Task Rule80_APayeeEditOfAPaymentDrawnFromAMovedJar_KeepsTheDraw()
    {
        // A Groceries payment of 100 was drawn from Holiday ("which jar?", rule 79) on 20 Aug;
        // Holiday then moved to B. A payee edit (no jar answer: A backs no jar now) keeps the draw.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, Aug1);
        var (_, groceries) = SeedAugust(db, jar);
        var payment = await new CreateTransactionCommandHandler(db, User).Handle(new CreateTransactionCommand(
            Aug20, "Shop", 100m, TransactionType.Expense, groceries.Id, a.Id, PaidFromJarId: jar.Id), Ct);
        await MoveAsync(db, jar, b, Sep1);
        var update = new UpdateTransactionCommandHandler(db, User);

        await update.Handle(new UpdateTransactionCommand(payment.Id, Aug20, "Shop Ltd", 100m, TransactionType.Expense, a.Id), Ct);
        var august = await ViewAsync(db, a.Id, Aug31);
        (august.AccountBalance, august.JarBalances[jar.Id], august.Unallocated).Should().Be((900m, 0m, 900m));

        // Echoed back by a form that still shows the answer: the same.
        await update.Handle(new UpdateTransactionCommand(payment.Id, Aug20, "Shop", 60m, TransactionType.Expense, a.Id, PaidFromJarId: jar.Id), Ct);
        var corrected = await ViewAsync(db, a.Id, Aug31);
        (corrected.AccountBalance, corrected.JarBalances[jar.Id], corrected.Unallocated).Should().Be((940m, 40m, 900m));
        var september = await ViewAsync(db, a.Id, Sep1);
        (september.AccountBalance, september.JarBalances[jar.Id], september.Unallocated).Should().Be((940m, 0m, 940m));
        await AssertDepartedJarsHoldNothingAsync(db);
    }
}
