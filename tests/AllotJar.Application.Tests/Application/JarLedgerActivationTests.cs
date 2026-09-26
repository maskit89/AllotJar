using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarLedger;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The actual-money jar ledger, activated end to end through the Application handlers
/// (AGREED-RULES 1–11, 26, 48, 67, 70, 73–81): a jar's balance is only ever the money
/// allocated to it in its designated account, less the payments its budget line draws from
/// that account. Plans never count; nothing is seeded; every write is validated against the
/// account's real money.
/// </summary>
public class JarLedgerActivationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new("user-1");
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-jarledger-{Guid.NewGuid()}")
            .Options);

    private static Jar SeedJar(ApplicationDbContext db, Account account, string name = "Holiday", decimal target = 1000m, string owner = "user-1")
    {
        var jar = new Jar
        {
            OwnerId = owner, Name = name, Kind = JarKind.Goal, TargetAmount = target,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A month with a Savings group holding one line per jar; returns the lines keyed by jar id.</summary>
    private static Dictionary<Guid, BudgetItem> SeedMonthWithJarLines(ApplicationDbContext db, int year, int month, params Jar[] jars)
    {
        var lines = jars.ToDictionary(j => j.Id, j => new BudgetItem { Name = j.Name, SavingsId = j.Id, PlannedAmount = 100m });
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = lines.Values.ToList() },
            },
        });
        db.SaveChanges();
        return lines;
    }

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid jarId, DateOnly? asOf = null)
    {
        var jars = await new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(IncludeArchived: true, AsOf: asOf), CancellationToken.None);
        return jars.Single(j => j.Id == jarId).CurrentBalance;
    }

    private static async Task<JarAccountLedgerDto> LedgerAsync(ApplicationDbContext db, Guid accountId, DateOnly? asOf = null)
    {
        var ledgers = await new GetJarLedgerQueryHandler(db, User).Handle(new GetJarLedgerQuery(asOf, accountId), CancellationToken.None);
        return ledgers.Single();
    }

    // ---- Rule 1: plans are not money -----------------------------------------------------------

    [Fact]
    public async Task PlannedContributions_NeverCount_TowardsTheJarBalance()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var jar = SeedJar(db, account);
        SeedMonthWithJarLines(db, 2026, 6, jar);
        SeedMonthWithJarLines(db, 2026, 7, jar);

        (await BalanceAsync(db, jar.Id)).Should().Be(0m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.Unallocated.Should().Be(500m, "the plan moved nothing; all the account's money is unallocated");
        ledger.AccountBalance.Should().Be(500m);
    }

    // ---- Rule 77: the initial allocation divides existing money -------------------------------

    [Fact]
    public async Task CreateJar_WithInitialAllocation_DividesUnallocatedMoney_WithoutChangingTheAccount()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);

        var dto = await new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 300m), CancellationToken.None);

        dto.CurrentBalance.Should().Be(300m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.AccountBalance.Should().Be(500m, "an allocation is not a deposit (rule 9)");
        ledger.Unallocated.Should().Be(200m);
        ledger.Jars.Single().Balance.Should().Be(300m);
        var stored = await db.JarAllocations.Include(a => a.Postings).SingleAsync();
        stored.Kind.Should().Be(JarAllocationKind.InitialAllocation);
        stored.Postings.Sum(p => p.Amount).Should().Be(0m);
    }

    [Fact]
    public async Task CreateJar_InitialAllocation_IsRefused_WhenUnallocatedIsShort()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var car = SeedJar(db, account, "Car");
        LedgerFixtures.Allocate(db, "user-1", account.Id, car.Id, 400m); // 100 left unallocated

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 150m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("InitialAllocation");
        // Nothing half-written: no jar, no allocation, no planted line.
        db.Jars.Count().Should().Be(1);
        db.JarAllocations.Count().Should().Be(1);
    }

    [Fact]
    public async Task CreateJar_InitialAllocation_IsRefused_BeforeTheAccountOpeningDate()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m, openingDate: new DateOnly(2026, 3, 1));

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 100m, InitialAllocationDate: new DateOnly(2026, 2, 28)), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("InitialAllocationDate");
        db.JarAllocations.Should().BeEmpty();
    }

    [Fact]
    public async Task CreateJar_InitialAllocation_IsRefused_InTheFuture()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 100m, InitialAllocationDate: Today.AddDays(1)), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("InitialAllocationDate");
        db.JarAllocations.Should().BeEmpty();
    }

    [Fact]
    public async Task CreateJar_BackdatedInitialAllocation_IsValidatedAgainstUnallocatedOnThatDate()
    {
        // 500 opening; a 450 no-line payment on 10 March leaves 50 unallocated from then on.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        LedgerFixtures.Expense(db, "user-1", account.Id, 450m, new DateOnly(2026, 3, 10));

        var handler = new CreateJarCommandHandler(db, User);
        // On 1 March the whole 500 was free.
        var dto = await handler.Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 300m, InitialAllocationDate: new DateOnly(2026, 3, 1)), CancellationToken.None);
        dto.CurrentBalance.Should().Be(300m);

        // After the payment only 50 is unallocated: a second jar cannot claim 100 on 20 March.
        var act = () => handler.Handle(new CreateJarCommand(
            "Car", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate,
            account.Id, InitialAllocation: 100m, InitialAllocationDate: new DateOnly(2026, 3, 20)), CancellationToken.None);
        await act.Should().ThrowAsync<ValidationException>();
    }

    // ---- Rule 79: outgoing money identifies its jar through the budget line --------------------

    [Fact]
    public async Task Expense_OnTheJarLine_FromTheJarsAccount_ReducesTheJar()
    {
        // Savings 1,000: Holiday 400, unallocated 600. A 250 hotel bill on the Holiday line leaves
        // Holiday 150 and the account 750 (rule 79's confirmed example).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday);
        LedgerFixtures.Expense(db, "user-1", account.Id, 250m, new DateOnly(2026, 6, 12), lines[holiday.Id].Id);

        (await BalanceAsync(db, holiday.Id)).Should().Be(150m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.AccountBalance.Should().Be(750m);
        ledger.Unallocated.Should().Be(600m);
    }

    [Fact]
    public async Task Expense_WithNoLine_ReducesUnallocated_NotTheJar()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        LedgerFixtures.Expense(db, "user-1", account.Id, 100m, new DateOnly(2026, 6, 12));

        (await BalanceAsync(db, holiday.Id)).Should().Be(400m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.Unallocated.Should().Be(500m);
        ledger.AccountBalance.Should().Be(900m);
    }

    [Fact]
    public async Task SplitExpense_AcrossTwoJarLines_DrawsEachSliceFromItsJar()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account, "Holiday");
        var car = SeedJar(db, account, "Car");
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, car.Id, 300m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday, car);

        var tx = new Transaction
        {
            OwnerId = "user-1", AccountId = account.Id, Amount = 150m, Currency = CurrencyCode.Eur,
            Type = TransactionType.Expense, Date = new DateOnly(2026, 6, 12), Payee = "Garage + hotel",
            Splits = new List<TransactionSplit>
            {
                new() { BudgetItemId = lines[holiday.Id].Id, Amount = 100m },
                new() { BudgetItemId = lines[car.Id].Id, Amount = 50m },
            },
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        (await BalanceAsync(db, holiday.Id)).Should().Be(300m);
        (await BalanceAsync(db, car.Id)).Should().Be(250m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.Unallocated.Should().Be(300m, "the slices drew from the jars, not the float");
        ledger.AccountBalance.Should().Be(850m);
    }

    [Fact]
    public async Task Income_LandsUnallocated_UntilAllocated()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        LedgerFixtures.Income(db, "user-1", account.Id, 500m, new DateOnly(2026, 6, 1));

        (await BalanceAsync(db, holiday.Id)).Should().Be(400m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.Unallocated.Should().Be(1100m);
        ledger.AccountBalance.Should().Be(1500m);
    }

    [Fact]
    public async Task JarPayment_MayTakeTheJarNegative_WhilePositiveJarsStayBacked()
    {
        // Rule 79's third example: a 500 repair on the Car line leaves Car −200 (rule 5) with the
        // positive Holiday 400 still backed by the account's 500 (rule 70).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account, "Holiday");
        var car = SeedJar(db, account, "Car");
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, car.Id, 300m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday, car);
        LedgerFixtures.Expense(db, "user-1", account.Id, 500m, new DateOnly(2026, 6, 12), lines[car.Id].Id);

        (await BalanceAsync(db, car.Id)).Should().Be(-200m);
        (await BalanceAsync(db, holiday.Id)).Should().Be(400m);
        var ledger = await LedgerAsync(db, account.Id);
        ledger.AccountBalance.Should().Be(500m);
        ledger.PositiveAllocations.Should().Be(400m);
        ledger.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task JarsPlusUnallocated_AlwaysEqualTheAccountBalance()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account, "Holiday");
        var car = SeedJar(db, account, "Car");
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, car.Id, 300m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday, car);
        LedgerFixtures.Expense(db, "user-1", account.Id, 250m, new DateOnly(2026, 6, 3), lines[holiday.Id].Id);
        LedgerFixtures.Expense(db, "user-1", account.Id, 100m, new DateOnly(2026, 6, 4));
        LedgerFixtures.Expense(db, "user-1", account.Id, 500m, new DateOnly(2026, 6, 5), lines[car.Id].Id);
        LedgerFixtures.Income(db, "user-1", account.Id, 80m, new DateOnly(2026, 6, 6));

        var ledger = await LedgerAsync(db, account.Id);
        ledger.AccountBalance.Should().Be(1000m - 250m - 100m - 500m + 80m);
        (ledger.Jars.Sum(j => j.Balance) + ledger.Unallocated).Should().Be(ledger.AccountBalance);
        ledger.Jars.Single(j => j.Name == "Holiday").Balance.Should().Be(150m);
        ledger.Jars.Single(j => j.Name == "Car").Balance.Should().Be(-200m);
        ledger.Unallocated.Should().Be(280m);
    }

    // ---- Rule 26 / 80: archiving and re-designating need a zero balance ---------------------------

    [Fact]
    public async Task Archive_IsRefused_WhileTheJarHoldsMoney_AndAllowedAtZero()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        var handler = new ArchiveJarCommandHandler(db, User);

        var act = () => handler.Handle(new ArchiveJarCommand(holiday.Id), CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Id"].Single().Should().Contain("400");
        (await db.Jars.SingleAsync()).IsArchived.Should().BeFalse();

        // Move it all back to unallocated; the jar is then archivable.
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, -400m, kind: JarAllocationKind.Reallocation);
        var dto = await handler.Handle(new ArchiveJarCommand(holiday.Id), CancellationToken.None);
        dto.IsArchived.Should().BeTrue();
        dto.CurrentBalance.Should().Be(0m);
    }

    [Fact]
    public async Task Archive_IsRefused_WhileTheJarIsOverdrawn()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday);
        LedgerFixtures.Expense(db, "user-1", account.Id, 50m, new DateOnly(2026, 6, 12), lines[holiday.Id].Id);

        var act = () => new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Id"].Single().Should().Contain("overdrawn");
    }

    [Fact]
    public async Task ChangingTheAccount_IsRefused_WhileTheJarHoldsMoney_AndAllowedAtZero()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, "user-1", "Savings", opening: 1000m);
        var current = LedgerFixtures.SeedAccount(db, "user-1", "Current", opening: 200m, type: AccountType.Current, order: 1);
        var holiday = SeedJar(db, savings);
        LedgerFixtures.Allocate(db, "user-1", savings.Id, holiday.Id, 400m);
        var handler = new UpdateJarCommandHandler(db, User);

        UpdateJarCommand Move() => new(holiday.Id, "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate, current.Id);

        var act = () => handler.Handle(Move(), CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("FundingAccountId");
        (await db.Jars.AsNoTracking().SingleAsync()).FundingAccountId.Should().Be(savings.Id);

        LedgerFixtures.Allocate(db, "user-1", savings.Id, holiday.Id, -400m, kind: JarAllocationKind.Reallocation);
        var dto = await handler.Handle(Move(), CancellationToken.None);
        dto.FundingAccountId.Should().Be(current.Id);
        dto.CurrentBalance.Should().Be(0m);
        // History stays with the previous account (rule 80): its money is all unallocated again,
        // and it no longer backs a jar.
        var rows = (await new GetAccountReconciliationQueryHandler(db, User)
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).ToDictionary(r => r.AccountId);
        rows[savings.Id].BackedJarCount.Should().Be(0);
        rows[savings.Id].Float.Should().Be(1000m);
        rows[current.Id].BackedJarCount.Should().Be(1);
        rows[current.Id].BackedJarsTotal.Should().Be(0m);
        rows[current.Id].Float.Should().Be(200m);
    }

    [Fact]
    public async Task ChangingTheAccount_ToACreditCard_IsRefused()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, "user-1", "Savings", opening: 1000m);
        var card = LedgerFixtures.SeedAccount(db, "user-1", "Visa", opening: 0m, type: AccountType.CreditCard, order: 1);
        var holiday = SeedJar(db, savings);

        var act = () => new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate, card.Id), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("FundingAccountId");
    }

    // ---- Rule 48 / 67: as-of balances in the budget grid ----------------------------------------

    [Fact]
    public async Task BudgetGrid_ShowsTheJarAsOfEachMonthsEnd_ExcludingLaterActivity()
    {
        // Rule 48's confirmed example: 300 at September month-end, +100 in October → September's
        // grid shows 300 while the current balance is 400.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 300m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 100m, new DateOnly(2026, 9, 25), JarAllocationKind.Reallocation);
        SeedMonthWithJarLines(db, 2026, 7, holiday);
        SeedMonthWithJarLines(db, 2026, 8, holiday);

        var grid = new GetBudgetMonthQueryHandler(db, User);
        var july = await grid.Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        var august = await grid.Handle(new GetBudgetMonthQuery(2026, 8), CancellationToken.None);

        july.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable.Should().Be(0m);
        august.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable.Should().Be(300m);
        (await BalanceAsync(db, holiday.Id)).Should().Be(400m);
        (await BalanceAsync(db, holiday.Id, new DateOnly(2026, 8, 31))).Should().Be(300m);
    }

    [Fact]
    public async Task BudgetGrid_ShowsUnavailable_ForAMonthBeforeTheAccountOpened()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m, openingDate: new DateOnly(2026, 6, 1));
        var holiday = SeedJar(db, account);
        SeedMonthWithJarLines(db, 2026, 5, holiday);
        SeedMonthWithJarLines(db, 2026, 6, holiday);

        var grid = new GetBudgetMonthQueryHandler(db, User);
        var may = await grid.Handle(new GetBudgetMonthQuery(2026, 5), CancellationToken.None);
        var june = await grid.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        may.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable
            .Should().BeNull("rule 67: not zero, not reconstructed");
        june.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable.Should().Be(0m);
        (await BalanceAsync(db, holiday.Id, new DateOnly(2026, 5, 31))).Should().BeNull();
    }

    [Fact]
    public async Task CreateBudgetMonth_SeedsTheContribution_FromTheLedgerBalanceOnTheDayBeforeTheMonth()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1200m,
            TargetDate = new DateOnly(2026, 12, 1), Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 300m, new DateOnly(2026, 5, 31));
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 300m, new DateOnly(2026, 6, 1), JarAllocationKind.Reallocation);

        var june = await new CreateBudgetMonthCommandHandler(db, User)
            .Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false), CancellationToken.None);

        // Balance as of 31 May = 300 (the 1 June allocation is excluded): (1200 − 300) ÷ 6 = 150.
        june.Categories.Single(c => c.Kind == "Savings").Items.Single().PlannedAmount.Should().Be(150m);
    }

    // ---- Rule 70: reconciliation ---------------------------------------------------------------

    [Fact]
    public async Task Reconciliation_ReportsJarsTotal_Unallocated_AndTheBackingDeficit()
    {
        // Rule 70's example: after a 150 Holiday payment from 500 (Holiday 100, Repairs 400) the
        // account has 350, Holiday −50, Repairs 400: positive jars 400 exceed the account's 350.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var holiday = SeedJar(db, account, "Holiday");
        var repairs = SeedJar(db, account, "Repairs");
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 100m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, repairs.Id, 400m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday, repairs);

        var recon = new GetAccountReconciliationQueryHandler(db, User);
        var before = (await recon.Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).Single();
        before.CurrentBalance.Should().Be(500m);
        before.BackedJarsTotal.Should().Be(500m);
        before.BackedJarCount.Should().Be(2);
        before.Float.Should().Be(0m);
        before.HasBackingDeficit.Should().BeFalse();

        LedgerFixtures.Expense(db, "user-1", account.Id, 150m, new DateOnly(2026, 6, 10), lines[holiday.Id].Id);

        var after = (await recon.Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).Single();
        after.CurrentBalance.Should().Be(350m);
        after.BackedJarsTotal.Should().Be(350m, "the signed sum: −50 + 400");
        after.Float.Should().Be(0m);
        after.HasBackingDeficit.Should().BeTrue("positive jars (400) exceed the account's money (350)");

        // The explicit 50 cover from Repairs (rule 70) clears it: Holiday 0, Repairs 350.
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(account.Id, repairs.Id, holiday.Id, 50m), CancellationToken.None);
        var covered = (await recon.Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).Single();
        covered.HasBackingDeficit.Should().BeFalse();
        covered.BackedJarsTotal.Should().Be(350m);
        (await BalanceAsync(db, holiday.Id)).Should().Be(0m);
        (await BalanceAsync(db, repairs.Id)).Should().Be(350m);
    }

    [Fact]
    public async Task Reconciliation_ExcludesArchivedJarsFromTheCount_ButTheyStayInTheLedger()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var active = SeedJar(db, account, "Active");
        var archived = SeedJar(db, account, "Archived");
        archived.IsArchived = true;
        db.SaveChanges();
        LedgerFixtures.Allocate(db, "user-1", account.Id, active.Id, 100m);

        var recon = (await new GetAccountReconciliationQueryHandler(db, User)
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).Single();

        recon.BackedJarCount.Should().Be(1);
        recon.BackedJarsTotal.Should().Be(100m);
        recon.Float.Should().Be(400m);
        (await LedgerAsync(db, account.Id)).Jars.Should().Contain(j => j.Name == "Archived" && j.IsArchived && j.Balance == 0m);
    }

    // ---- Rules 73 / 75 / 79: what is refused ----------------------------------------------------

    [Fact]
    public async Task AddBudgetItem_IntoASavingsGroup_IsRefused()
    {
        await using var db = NewContext();
        var savings = new BudgetCategory { Name = "Savings", Kind = CategoryKind.Savings };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { savings },
        });
        db.SaveChanges();

        var act = () => new AddBudgetItemCommandHandler(db, User)
            .Handle(new AddBudgetItemCommand(savings.Id, "Holiday", 100m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Name"].Single().Should().Contain("jar");
        db.BudgetItems.Should().BeEmpty();
        db.Jars.Should().BeEmpty();
    }

    [Fact]
    public async Task JarLinePayment_FromAnotherAccount_IsRefused()
    {
        // Rule 79: only a payment from the jar's own account draws from the jar. From another
        // account (or no account) the attribution would be a plan, so it is refused.
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, "user-1", "Savings", opening: 1000m);
        var current = LedgerFixtures.SeedAccount(db, "user-1", "Current", opening: 500m, type: AccountType.Current, order: 1);
        var holiday = SeedJar(db, savings);
        LedgerFixtures.Allocate(db, "user-1", savings.Id, holiday.Id, 400m);
        var lines = SeedMonthWithJarLines(db, 2026, 6, holiday);
        var handler = new CreateTransactionCommandHandler(db, User);

        var fromCurrent = () => handler.Handle(new CreateTransactionCommand(
            new DateOnly(2026, 6, 12), "Hotel", 250m, TransactionType.Expense, lines[holiday.Id].Id, AccountId: current.Id), CancellationToken.None);
        var ex = await fromCurrent.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Values.SelectMany(v => v).Should().Contain(m => m.Contains("Savings"));

        var fromNowhere = () => handler.Handle(new CreateTransactionCommand(
            new DateOnly(2026, 6, 12), "Hotel", 250m, TransactionType.Expense, lines[holiday.Id].Id, AccountId: null), CancellationToken.None);
        await fromNowhere.Should().ThrowAsync<ValidationException>();

        var asSlice = () => handler.Handle(new CreateTransactionCommand(
            new DateOnly(2026, 6, 12), "Hotel", 250m, TransactionType.Expense, null, AccountId: current.Id,
            Splits: new[] { new SplitAllocationInput(lines[holiday.Id].Id, 250m) }), CancellationToken.None);
        await asSlice.Should().ThrowAsync<ValidationException>();

        db.Transactions.Should().BeEmpty();

        // From the jar's own account it is accepted and comes out of the jar.
        await handler.Handle(new CreateTransactionCommand(
            new DateOnly(2026, 6, 12), "Hotel", 250m, TransactionType.Expense, lines[holiday.Id].Id, AccountId: savings.Id), CancellationToken.None);
        (await BalanceAsync(db, holiday.Id)).Should().Be(150m);
    }

    [Fact]
    public async Task CreateJar_WithACreditCardAccount_IsRefused()
    {
        await using var db = NewContext();
        var card = LedgerFixtures.SeedAccount(db, "user-1", "Visa", opening: 0m, type: AccountType.CreditCard);

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate, card.Id), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["FundingAccountId"].Single().Should().Contain("credit card");
        db.Jars.Should().BeEmpty();
    }

    [Fact]
    public async Task CreateJar_WithAnotherHouseholdsAccount_IsForbidden()
    {
        await using var db = NewContext();
        var theirs = LedgerFixtures.SeedAccount(db, "user-2");

        var act = () => new CreateJarCommandHandler(db, User).Handle(new CreateJarCommand(
            "Holiday", JarKind.Goal, 1000m, null, null, null, AccrualMethod.TargetByDate, theirs.Id), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task DeleteAccount_IsRefused_WhileItBacksAJar_OrHoldsAllocationHistory()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 1000m);
        var holiday = SeedJar(db, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, 400m);
        var handler = new DeleteAccountCommandHandler(db, User);

        var backing = () => handler.Handle(new DeleteAccountCommand(account.Id), CancellationToken.None);
        (await backing.Should().ThrowAsync<ValidationException>()).Which.Errors["Id"].Single().Should().Contain("jar");

        // Even with the jar moved elsewhere, the allocation history pins the account.
        var other = LedgerFixtures.SeedAccount(db, "user-1", "Other", opening: 0m, order: 1);
        LedgerFixtures.Allocate(db, "user-1", account.Id, holiday.Id, -400m, kind: JarAllocationKind.Reallocation);
        holiday.FundingAccountId = other.Id;
        db.SaveChanges();
        var history = () => handler.Handle(new DeleteAccountCommand(account.Id), CancellationToken.None);
        (await history.Should().ThrowAsync<ValidationException>()).Which.Errors["Id"].Single().Should().Contain("history");
        db.Accounts.Count().Should().Be(2);
    }

    // ---- Rules 74 / 75 / 76: account validators --------------------------------------------------

    [Fact]
    public void AccountValidators_RefuseANegativeOpeningBalance()
    {
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Overdraft", AccountType.Current, "EUR", -0.01m, new DateOnly(2026, 1, 1)))
            .Errors.Should().ContainSingle(e => e.PropertyName == "OpeningBalance");
        new UpdateAccountCommandValidator()
            .Validate(new UpdateAccountCommand(Guid.NewGuid(), "Overdraft", AccountType.Current, -100m, new DateOnly(2026, 1, 1)))
            .Errors.Should().ContainSingle(e => e.PropertyName == "OpeningBalance");
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Piggy bank", AccountType.Cash, "EUR", 0m, new DateOnly(2026, 1, 1)))
            .IsValid.Should().BeTrue();
    }

    [Fact]
    public void AccountValidators_RefuseACreditCard()
    {
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Visa", AccountType.CreditCard, "EUR", 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().ContainSingle(e => e.PropertyName == "Type");
        new UpdateAccountCommandValidator()
            .Validate(new UpdateAccountCommand(Guid.NewGuid(), "Visa", AccountType.CreditCard, 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().ContainSingle(e => e.PropertyName == "Type");
    }

    [Theory]
    [InlineData("GB29 NWBK 6016 1331 9268 19", true)]
    [InlineData("de89370400440532013000", true)]
    [InlineData("MT84MALT011000012345MTLCAST001S", true)]
    [InlineData("GB29", false)]
    [InlineData("1234567890123456", false)]
    [InlineData("GB2X NWBK 6016 1331 9268 19", false)]
    public void Iban_IsFormatCheckedOnlyWhenSupplied(string iban, bool valid)
    {
        BankIdentifiers.IsValidIban(iban).Should().Be(valid);
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Bank", AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1), Iban: iban))
            .Errors.Any(e => e.PropertyName == "Iban").Should().Be(!valid);
    }

    [Theory]
    [InlineData("NWBKGB2L", true)]
    [InlineData("nwbkgb2lxxx", true)]
    [InlineData("VALLMTMT", true)]
    [InlineData("NWBKGB2", false)]
    [InlineData("NWBKGB2LXX", false)]
    [InlineData("12345678", false)]
    public void Bic_IsFormatCheckedOnlyWhenSupplied(string bic, bool valid)
    {
        BankIdentifiers.IsValidBic(bic).Should().Be(valid);
        new UpdateAccountCommandValidator()
            .Validate(new UpdateAccountCommand(Guid.NewGuid(), "Bank", AccountType.Current, 0m, new DateOnly(2026, 1, 1), Bic: bic))
            .Errors.Any(e => e.PropertyName == "Bic").Should().Be(!valid);
    }

    [Theory]
    [InlineData("12-34-56", true)]
    [InlineData("123456", true)]
    [InlineData("12 34 56", true)]
    [InlineData("12-34-5", false)]
    [InlineData("1234567", false)]
    [InlineData("12-3A-56", false)]
    public void SortCode_IsFormatCheckedOnlyWhenSupplied(string sortCode, bool valid)
    {
        BankIdentifiers.IsValidSortCode(sortCode).Should().Be(valid);
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Bank", AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1), SortCode: sortCode))
            .Errors.Any(e => e.PropertyName == "SortCode").Should().Be(!valid);
    }

    [Fact]
    public void BankIdentifiers_AreOptional_AndNormalised()
    {
        // Rule 76: a piggy bank has none of them; none is required.
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Piggy bank", AccountType.Cash, "EUR", 20m, new DateOnly(2026, 1, 1)))
            .IsValid.Should().BeTrue();
        BankIdentifiers.NormalizeIban(" gb29 nwbk 6016 1331 9268 19 ").Should().Be("GB29NWBK60161331926819");
        BankIdentifiers.NormalizeSortCode("12-34-56").Should().Be("123456");
        BankIdentifiers.NormalizeBic(" nwbkgb2l ").Should().Be("NWBKGB2L");
        BankIdentifiers.NormalizeAccountNumber("  ").Should().BeNull();
        BankIdentifiers.IsValidAccountNumber("123").Should().BeFalse();
        BankIdentifiers.IsValidAccountNumber("12345678").Should().BeTrue();
    }
}
