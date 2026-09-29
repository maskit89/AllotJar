using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rules 78 and 79 through the write handlers: incoming money is divided among the account's
/// jars as the user answers (the rest unallocated); outgoing money draws from the jar its budget
/// line names, otherwise from the jar the user names, otherwise from unallocated. Balances are
/// read through <see cref="JarLedgerReader"/>, the stored postings through the JarAllocations set
/// and the transaction DTO. Fixture: Savings 1,000 backing Holiday 400 and Car 300 (unallocated 300).
/// </summary>
public class JarMovementsTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly DateOnly June5 = new(2026, 6, 5);
    private static readonly DateOnly June6 = new(2026, 6, 6);
    private static readonly DateOnly June8 = new(2026, 6, 8);
    private static readonly DateOnly AsOf = new(2026, 6, 30);

    private static Jar SeedJar(ApplicationDbContext db, Account account, string name, decimal allocated = 0m)
    {
        var jar = new Jar
        {
            OwnerId = account.OwnerId, Name = name, Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        if (allocated != 0m)
        {
            LedgerFixtures.Allocate(db, account.OwnerId, account.Id, jar.Id, allocated);
        }
        return jar;
    }

    /// <summary>June 2026 with a Savings group holding one line per jar and an Expense group with a Groceries line.</summary>
    private static (Dictionary<Guid, BudgetItem> JarLines, BudgetItem Groceries) SeedJune(ApplicationDbContext db, params Jar[] jars)
    {
        var jarLines = jars.ToDictionary(j => j.Id, j => new BudgetItem { Name = j.Name, SavingsId = j.Id, PlannedAmount = 100m });
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = jarLines.Values.ToList() },
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries } },
            },
        });
        db.SaveChanges();
        return (jarLines, groceries);
    }

    private sealed record Fixture(Account Savings, Jar Holiday, Jar Car, Dictionary<Guid, BudgetItem> JarLines, BudgetItem Groceries);

    /// <summary>The rule 79 fixture: Savings 1,000 with Holiday 400, Car 300, unallocated 300, and June's lines.</summary>
    private static Fixture SeedFixture(ApplicationDbContext db)
    {
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 1000m);
        var holiday = SeedJar(db, savings, "Holiday", 400m);
        var car = SeedJar(db, savings, "Car", 300m);
        var (jarLines, groceries) = SeedJune(db, holiday, car);
        return new Fixture(savings, holiday, car, jarLines, groceries);
    }

    private static Task<JarLedgerSnapshot> ReadAsync(ApplicationDbContext db) =>
        JarLedgerReader.ReadAsync(db, Owner, AsOf, CancellationToken.None);

    private static CreateTransactionCommand Income(Guid accountId, decimal amount, string payee = "Employer",
        IReadOnlyList<JarAllocationInput>? jarAllocations = null) =>
        new(June5, payee, amount, TransactionType.Income, null, accountId, JarAllocations: jarAllocations);

    private static CreateTransactionCommand Expense(Guid accountId, decimal amount, Guid? lineId, string payee,
        Guid? paidFromJarId = null, IReadOnlyList<SplitAllocationInput>? splits = null) =>
        new(June5, payee, amount, TransactionType.Expense, lineId, accountId, Splits: splits, PaidFromJarId: paidFromJarId);

    private static Task<ValidationException> RefusedAsync(Func<Task> act) => Assert.ThrowsAsync<ValidationException>(act);

    private static Task<List<JarAllocation>> StoredMovementsAsync(ApplicationDbContext db, Guid transactionId) =>
        db.JarAllocations.AsNoTracking().Include(a => a.Postings)
            .Where(a => a.TransactionId == transactionId).ToListAsync();

    // ---- Rule 78: incoming money -------------------------------------------------------------

    [Fact]
    public async Task Income_WithJarAllocations_CreditsEachJar_AndLeavesUnallocatedUnchanged()
    {
        // The rule's confirmed example: 500 arrives; Holiday 300, Car 200; unallocated unchanged.
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m), new JarAllocationInput(f.Car.Id, 200m) }),
            CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(700m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(500m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(1500m);
        snapshot.Accounts[f.Savings.Id].UnreconciledAllocations.Should().Be(0);

        var stored = (await StoredMovementsAsync(db, dto.Id)).Should().ContainSingle().Subject;
        stored.Kind.Should().Be(JarAllocationKind.Movement);
        stored.AccountId.Should().Be(f.Savings.Id);
        stored.Date.Should().Be(June5);
        stored.Postings.Sum(p => p.Amount).Should().Be(500m, "a movement's postings conserve the leg");
        stored.Postings.Should().HaveCount(2, "nothing was left unallocated, so no unallocated posting");
        stored.Postings.Single(p => p.JarId == f.Holiday.Id).Amount.Should().Be(300m);
        stored.Postings.Single(p => p.JarId == f.Car.Id).Amount.Should().Be(200m);

        // The create handler's response carries the postings with jar names.
        dto.JarAllocations.Should().HaveCount(2);
        dto.JarAllocations.Single(a => a.JarId == f.Holiday.Id).Should().BeEquivalentTo(
            new { AccountId = f.Savings.Id, JarName = "Holiday", Amount = 300m });
        dto.JarAllocations.Single(a => a.JarId == f.Car.Id).JarName.Should().Be("Car");
    }

    [Fact]
    public async Task Income_WithoutJarAllocations_LandsUnallocated_AndStoresNothing()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(Income(f.Savings.Id, 500m), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(800m);
        (await StoredMovementsAsync(db, dto.Id)).Should().BeEmpty("the derived default (unallocated) needs no stored row");
        dto.JarAllocations.Should().BeEmpty();
    }

    [Fact]
    public async Task Income_WithPartialJarAllocations_LeavesTheRemainderUnallocated()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m) }), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(700m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(500m);
        var stored = (await StoredMovementsAsync(db, dto.Id)).Single();
        stored.Postings.Single(p => p.JarId == null).Amount.Should().Be(200m, "the remainder is an explicit unallocated posting");
        stored.Postings.Sum(p => p.Amount).Should().Be(500m);
    }

    [Fact]
    public async Task Income_WithJarAllocationsExceedingTheAmount_IsRefused_AndNothingIsPersisted()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var ex = await RefusedAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m), new JarAllocationInput(f.Car.Id, 300m) }),
            CancellationToken.None));

        ex.Errors.Should().ContainKey("JarAllocations").WhoseValue.Single().Should().Contain("600").And.Contain("500");
        (await db.Transactions.CountAsync()).Should().Be(0);
        (await db.JarAllocations.CountAsync(a => a.Kind == JarAllocationKind.Movement)).Should().Be(0);
    }

    [Fact]
    public async Task Income_DividedIntoAJarOfAnotherAccount_IsRefused()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Other", opening: 100m, order: 1);
        var elsewhere = SeedJar(db, other, "Elsewhere");

        var ex = await RefusedAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(elsewhere.Id, 100m) }), CancellationToken.None));

        ex.Errors["JarAllocations"].Single().Should().Contain("Elsewhere").And.Contain("not held in Savings");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public void CreateTransactionValidator_RejectsJarAllocationsOnAnExpense_AndPaidFromJarOnAnIncome()
    {
        var validator = new CreateTransactionCommandValidator();
        var accountId = Guid.NewGuid();
        var jarId = Guid.NewGuid();

        var expenseWithAllocations = validator.Validate(new CreateTransactionCommand(
            June5, "Shop", 50m, TransactionType.Expense, null, accountId, JarAllocations: new[] { new JarAllocationInput(jarId, 50m) }));
        expenseWithAllocations.IsValid.Should().BeFalse();
        expenseWithAllocations.Errors.Should().Contain(e => e.PropertyName == "JarAllocations");

        var incomePaidFromJar = validator.Validate(new CreateTransactionCommand(
            June5, "Employer", 50m, TransactionType.Income, null, accountId, PaidFromJarId: jarId));
        incomePaidFromJar.IsValid.Should().BeFalse();
        incomePaidFromJar.Errors.Should().Contain(e => e.PropertyName == "PaidFromJarId");

        // Neither prompt applies without an account.
        validator.Validate(new CreateTransactionCommand(
                June5, "Employer", 50m, TransactionType.Income, null, null, JarAllocations: new[] { new JarAllocationInput(jarId, 50m) }))
            .IsValid.Should().BeFalse();

        validator.Validate(new CreateTransactionCommand(
                June5, "Employer", 50m, TransactionType.Income, null, accountId, JarAllocations: new[] { new JarAllocationInput(jarId, 50m) }))
            .IsValid.Should().BeTrue();
    }

    // ---- Rule 79: outgoing money -------------------------------------------------------------

    [Fact]
    public async Task Expense_OnANonJarLine_PaidFromHoliday_DrawsFromHoliday()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 250m, f.Groceries.Id, "Hotel via groceries", paidFromJarId: f.Holiday.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(150m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(750m);
        var stored = (await StoredMovementsAsync(db, dto.Id)).Single();
        stored.Postings.Should().ContainSingle().Which.Should().BeEquivalentTo(new { JarId = (Guid?)f.Holiday.Id, Amount = -250m });
        dto.JarAllocations.Single().JarName.Should().Be("Holiday");
    }

    [Fact]
    public async Task Expense_OnANonJarLine_WithoutPaidFrom_DrawsFromUnallocated()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 100m, f.Groceries.Id, "Market"), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(200m);
        (await StoredMovementsAsync(db, dto.Id)).Should().BeEmpty("unallocated is the derived default");
    }

    [Fact]
    public async Task Expense_OnAJarLine_DrawsFromThatJar_AndNamingAnotherJarIsRefused()
    {
        // Rule 79's confirmed example: a 250 hotel bill on the Holiday line leaves Holiday 150.
        await using var db = NewContext();
        var f = SeedFixture(db);
        var handler = new CreateTransactionCommandHandler(db, User);

        var dto = await handler.Handle(Expense(f.Savings.Id, 250m, f.JarLines[f.Holiday.Id].Id, "Hotel"), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(150m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(750m);
        (await StoredMovementsAsync(db, dto.Id)).Should().BeEmpty("the line's jar is the derived attribution");

        var ex = await RefusedAsync(() => handler.Handle(
            Expense(f.Savings.Id, 50m, f.JarLines[f.Holiday.Id].Id, "Hotel extras", paidFromJarId: f.Car.Id), CancellationToken.None));
        ex.Errors["PaidFromJarId"].Single().Should().Contain("already on a jar's line");
        (await db.Transactions.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task SplitExpense_WithAJarLineSliceAndANonJarSlice_PaidFromCar_DrawsEachSliceFromItsJar()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 150m, null, "Garage + hotel", paidFromJarId: f.Car.Id, splits: new[]
            {
                new SplitAllocationInput(f.JarLines[f.Holiday.Id].Id, 100m),
                new SplitAllocationInput(f.Groceries.Id, 50m),
            }), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(300m, "the jar line's slice draws from Holiday");
        snapshot.BalanceOf(f.Car.Id).Should().Be(250m, "the other slice draws from the named jar");
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(850m);
        var stored = (await StoredMovementsAsync(db, dto.Id)).Single();
        stored.Postings.Sum(p => p.Amount).Should().Be(-150m);
        stored.Postings.Single(p => p.JarId == f.Holiday.Id).Amount.Should().Be(-100m);
        stored.Postings.Single(p => p.JarId == f.Car.Id).Amount.Should().Be(-50m);
    }

    // ---- UpdateTransaction re-answers the prompt ------------------------------------------------

    [Fact]
    public async Task UpdateIncome_WithNewJarAllocations_ReplacesTheStoredSplitInPlace()
    {
        // The stored row is rewritten in place (the (transaction, account) index is unique): the
        // old postings go, the new ones are inserted, and the ledger reads the re-answer.
        await using var db = NewContext();
        var f = SeedFixture(db);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m), new JarAllocationInput(f.Car.Id, 200m) }),
            CancellationToken.None);

        var dto = await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(created.Id, June5, "Employer", 600m, TransactionType.Income, f.Savings.Id,
                JarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 600m) }), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(1000m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m, "Car's 200 was withdrawn by the re-answer");
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(1600m);
        var stored = (await StoredMovementsAsync(db, created.Id)).Should().ContainSingle("the row is updated in place").Subject;
        stored.Postings.Should().ContainSingle().Which.Should().BeEquivalentTo(new { JarId = (Guid?)f.Holiday.Id, Amount = 600m });
        dto.JarAllocations.Should().ContainSingle().Which.JarName.Should().Be("Holiday");
    }

    [Fact]
    public async Task UpdateIncome_WithoutJarAllocations_MakesItAllUnallocated_AndRemovesTheStoredRow()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m), new JarAllocationInput(f.Car.Id, 200m) }),
            CancellationToken.None);

        var dto = await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(created.Id, June5, "Employer", 500m, TransactionType.Income, f.Savings.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(800m);
        (await StoredMovementsAsync(db, created.Id)).Should().BeEmpty("the prompt was dismissed on the edit");
        dto.JarAllocations.Should().BeEmpty();
    }

    [Fact]
    public async Task UpdateIncome_MovingItToAnotherAccount_ClearsTheOldLegsSplit()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current, order: 1);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m) }), CancellationToken.None);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(created.Id, June5, "Employer", 500m, TransactionType.Income, other.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m, "the 500 left with the income");
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(1000m);
        (await StoredMovementsAsync(db, created.Id)).Should().BeEmpty("the Savings leg no longer exists");
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == created.Id)).AccountId.Should().Be(other.Id);
    }

    // ---- AssignTransaction / SplitTransaction ----------------------------------------------------

    [Fact]
    public async Task AssignTransaction_ToANonJarLine_WithPaidFromJar_StoresTheAnswer()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 100m, null, "Market"), CancellationToken.None);
        (await ReadAsync(db)).Accounts[f.Savings.Id].Unallocated.Should().Be(200m, "a payment on no line draws from unallocated");

        var dto = await new AssignTransactionCommandHandler(db, User).Handle(
            new AssignTransactionCommand(created.Id, f.Groceries.Id, PaidFromJarId: f.Holiday.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        dto.BudgetItemId.Should().Be(f.Groceries.Id);
        dto.JarAllocations.Should().ContainSingle().Which.Should().BeEquivalentTo(
            new { AccountId = f.Savings.Id, JarId = (Guid?)f.Holiday.Id, JarName = "Holiday", Amount = -100m });

        // Re-assigning without an answer returns the payment to unallocated.
        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(created.Id, f.Groceries.Id), CancellationToken.None);
        (await ReadAsync(db)).BalanceOf(f.Holiday.Id).Should().Be(400m);
        (await StoredMovementsAsync(db, created.Id)).Should().BeEmpty();
    }

    [Fact]
    public void AssignTransactionValidator_RejectsPaidFromJar_WithoutALine()
    {
        var validator = new AssignTransactionCommandValidator();

        var result = validator.Validate(new AssignTransactionCommand(Guid.NewGuid(), null, PaidFromJarId: Guid.NewGuid()));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().ContainSingle().Which.PropertyName.Should().Be("PaidFromJarId");
        validator.Validate(new AssignTransactionCommand(Guid.NewGuid(), Guid.NewGuid(), PaidFromJarId: Guid.NewGuid())).IsValid.Should().BeTrue();
    }

    [Fact]
    public async Task SplitTransaction_WithPaidFromJar_DrawsTheJarLineSliceFromItsJar_AndTheRestFromTheNamedJar()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 150m, null, "Garage + hotel"), CancellationToken.None);

        var dto = await new SplitTransactionCommandHandler(db, User).Handle(
            new SplitTransactionCommand(created.Id, new[]
            {
                new SplitAllocationInput(f.JarLines[f.Holiday.Id].Id, 100m),
                new SplitAllocationInput(f.Groceries.Id, 50m),
            }, PaidFromJarId: f.Car.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(300m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(250m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        dto.IsSplit.Should().BeTrue();
        dto.JarAllocations.Select(a => (a.JarName, a.Amount)).Should().BeEquivalentTo(new[] { ("Holiday", -100m), ("Car", -50m) });
    }

    // ---- Transfers --------------------------------------------------------------------------------

    private static (Account Other, Jar Emergency) SeedDestination(ApplicationDbContext db)
    {
        var other = LedgerFixtures.SeedAccount(db, Owner, "Other", opening: 500m, order: 1);
        return (other, SeedJar(db, other, "Emergency"));
    }

    [Fact]
    public async Task CreateTransfer_WithFromJar_AndJarAllocationsOnTheDestination_MovesJarMoneyOnBothSides()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var (other, emergency) = SeedDestination(db);

        var dto = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(June5, 200m, f.Savings.Id, other.Id, ReceivedOn: June6,
                FromJarId: f.Holiday.Id, JarAllocations: new[] { new JarAllocationInput(emergency.Id, 200m) }), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(200m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(800m);
        snapshot.BalanceOf(emergency.Id).Should().Be(200m);
        snapshot.Accounts[other.Id].Unallocated.Should().Be(500m);
        snapshot.Accounts[other.Id].AccountBalance.Should().Be(700m);

        var stored = await StoredMovementsAsync(db, dto.Id);
        stored.Should().HaveCount(2, "each account leg has its own split");
        stored.Single(a => a.AccountId == f.Savings.Id).Postings.Single().Should().BeEquivalentTo(new { JarId = (Guid?)f.Holiday.Id, Amount = -200m });
        stored.Single(a => a.AccountId == other.Id).Postings.Single().Should().BeEquivalentTo(new { JarId = (Guid?)emergency.Id, Amount = 200m });
        dto.JarAllocations.Select(a => (a.JarName, a.Amount)).Should().BeEquivalentTo(new[] { ("Holiday", -200m), ("Emergency", 200m) });
    }

    [Fact]
    public async Task CreateTransfer_WithReceiptUnknown_DoesNotCreditTheDestinationJar_UntilTheReceiptIsConfirmed()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var (other, emergency) = SeedDestination(db);

        var dto = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(June5, 200m, f.Savings.Id, other.Id, ReceivedOn: null,
                FromJarId: f.Holiday.Id, JarAllocations: new[] { new JarAllocationInput(emergency.Id, 200m) }), CancellationToken.None);

        var inTransit = await ReadAsync(db);
        inTransit.BalanceOf(f.Holiday.Id).Should().Be(200m, "the departure is confirmed");
        inTransit.BalanceOf(emergency.Id).Should().Be(0m, "money in transit is in neither jar (rule 69)");
        inTransit.Accounts[other.Id].AccountBalance.Should().Be(500m);
        inTransit.Accounts[other.Id].Unallocated.Should().Be(500m);
        (await StoredMovementsAsync(db, dto.Id)).Should().Contain(a => a.AccountId == other.Id, "the answer is kept for when the receipt posts");

        // Confirming the receipt (with no new answer) applies the stored allocation.
        await new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(dto.Id, ReceivedOn: June8), CancellationToken.None);

        var received = await ReadAsync(db);
        received.BalanceOf(emergency.Id).Should().Be(200m);
        received.Accounts[other.Id].AccountBalance.Should().Be(700m);
        received.Accounts[other.Id].Unallocated.Should().Be(500m);
        received.Accounts[other.Id].UnreconciledAllocations.Should().Be(0);
    }

    [Fact]
    public async Task ConfirmTransferLegs_WithJarAllocationsAndReceivedOn_CreditsTheDestinationJar()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var (other, emergency) = SeedDestination(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(June5, 200m, f.Savings.Id, other.Id), CancellationToken.None);

        var dto = await new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: June8, JarAllocations: new[] { new JarAllocationInput(emergency.Id, 150m) }),
            CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(emergency.Id).Should().Be(150m);
        snapshot.Accounts[other.Id].Unallocated.Should().Be(550m);
        snapshot.Accounts[other.Id].AccountBalance.Should().Be(700m);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m, "no source jar was named, so the departure left unallocated");
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(100m);
        dto.ReceivedOn.Should().Be(June8);
        dto.JarAllocations.Single(a => a.JarId == emergency.Id).Amount.Should().Be(150m);
        dto.JarAllocations.Single(a => a.JarId == null).Amount.Should().Be(50m);
    }

    [Fact]
    public void ConfirmTransferLegsValidator_RejectsJarAllocations_WithoutAReceiptDate()
    {
        var validator = new ConfirmTransferLegsCommandValidator();
        var allocations = new[] { new JarAllocationInput(Guid.NewGuid(), 10m) };

        var result = validator.Validate(new ConfirmTransferLegsCommand(Guid.NewGuid(), DepartedOn: June5, JarAllocations: allocations));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "JarAllocations");
        validator.Validate(new ConfirmTransferLegsCommand(Guid.NewGuid(), ReceivedOn: June8, JarAllocations: allocations)).IsValid.Should().BeTrue();
    }

    // ---- CommitImport -----------------------------------------------------------------------------

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db) =>
        new(db, User);

    private static CommitImportItem Row(string reference, DateOnly date, decimal amount, bool isCredit,
        IReadOnlyList<JarAllocationInput>? jarAllocations = null, Guid? paidFromJarId = null) =>
        new(reference, date, isCredit ? "SALARY" : "SHOP", amount, "EUR", isCredit, null, null,
            JarAllocations: jarAllocations, PaidFromJarId: paidFromJarId);

    [Fact]
    public async Task CommitImport_CreditRowWithJarAllocations_CreditsTheJar()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var result = await NewCommit(db).Handle(new CommitImportCommand(f.Savings.Id, new[]
        {
            Row("c1", June5, 500m, isCredit: true, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m) }),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.HeldCount.Should().Be(0);
        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(700m);
        snapshot.BalanceOf(f.Car.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(500m);
        var imported = await db.Transactions.AsNoTracking().SingleAsync();
        (await StoredMovementsAsync(db, imported.Id)).Single().Postings.Sum(p => p.Amount).Should().Be(500m);
    }

    [Fact]
    public async Task CommitImport_DebitRowWithPaidFromJar_DebitsTheJar()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);

        var result = await NewCommit(db).Handle(new CommitImportCommand(f.Savings.Id, new[]
        {
            Row("d1", June5, 100m, isCredit: false, paidFromJarId: f.Holiday.Id),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(900m);
    }

    [Fact]
    public void CommitImportValidator_RejectsTheJarPrompts_InTheWrongDirection()
    {
        var validator = new CommitImportCommandValidator();
        var accountId = Guid.NewGuid();
        var jarId = Guid.NewGuid();

        var debitDivided = validator.Validate(new CommitImportCommand(accountId, new[]
        {
            Row("d1", June5, 100m, isCredit: false, jarAllocations: new[] { new JarAllocationInput(jarId, 100m) }),
        }));
        debitDivided.IsValid.Should().BeFalse();
        debitDivided.Errors.Should().Contain(e => e.PropertyName.EndsWith("JarAllocations"));

        var creditPaidFrom = validator.Validate(new CommitImportCommand(accountId, new[]
        {
            Row("c1", June5, 100m, isCredit: true, paidFromJarId: jarId),
        }));
        creditPaidFrom.IsValid.Should().BeFalse();
        creditPaidFrom.Errors.Should().Contain(e => e.PropertyName.EndsWith("PaidFromJarId"));

        validator.Validate(new CommitImportCommand(accountId, new[]
        {
            Row("c1", June5, 100m, isCredit: true, jarAllocations: new[] { new JarAllocationInput(jarId, 100m) }),
            Row("d1", June5, 100m, isCredit: false, paidFromJarId: jarId),
        })).IsValid.Should().BeTrue();
    }

    // ---- DeleteTransaction ------------------------------------------------------------------------

    [Fact]
    public async Task DeleteTransaction_RemovesItsJarMovement_SoTheJarBalanceReverts()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var created = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m) }), CancellationToken.None);
        (await ReadAsync(db)).BalanceOf(f.Holiday.Id).Should().Be(700m);

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(created.Id), CancellationToken.None);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(f.Holiday.Id).Should().Be(400m);
        snapshot.Accounts[f.Savings.Id].Unallocated.Should().Be(300m);
        snapshot.Accounts[f.Savings.Id].AccountBalance.Should().Be(1000m);
        snapshot.Accounts[f.Savings.Id].UnreconciledAllocations.Should().Be(0);
        // The movement row goes with its transaction (cascade); nothing dangling is left to read.
        (await StoredMovementsAsync(db, created.Id)).Should().BeEmpty();
        (await db.Transactions.AsNoTracking().AnyAsync(t => t.Id == created.Id)).Should().BeFalse();
    }

    // ---- The DTO -----------------------------------------------------------------------------------

    [Fact]
    public async Task GetTransactions_CarriesTheStoredJarPostings_WithJarNames()
    {
        await using var db = NewContext();
        var f = SeedFixture(db);
        var income = await new CreateTransactionCommandHandler(db, User).Handle(
            Income(f.Savings.Id, 500m, jarAllocations: new[] { new JarAllocationInput(f.Holiday.Id, 300m), new JarAllocationInput(f.Car.Id, 200m) }),
            CancellationToken.None);
        var plain = await new CreateTransactionCommandHandler(db, User).Handle(
            Expense(f.Savings.Id, 100m, f.Groceries.Id, "Market"), CancellationToken.None);

        var list = await new GetTransactionsQueryHandler(db, User).Handle(new GetTransactionsQuery(2026, 6), CancellationToken.None);

        var dto = list.Single(t => t.Id == income.Id);
        dto.JarAllocations.Should().HaveCount(2);
        dto.JarAllocations.Should().AllSatisfy(a => a.AccountId.Should().Be(f.Savings.Id));
        dto.JarAllocations.Single(a => a.JarId == f.Holiday.Id).Should().BeEquivalentTo(new { JarName = "Holiday", Amount = 300m });
        dto.JarAllocations.Single(a => a.JarId == f.Car.Id).Should().BeEquivalentTo(new { JarName = "Car", Amount = 200m });
        list.Single(t => t.Id == plain.Id).JarAllocations.Should().BeEmpty("a derived attribution stores nothing");
    }
}
