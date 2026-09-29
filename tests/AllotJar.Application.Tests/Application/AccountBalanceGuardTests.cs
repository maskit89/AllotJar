using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rule 74: no account may have a negative recorded balance on any date, whatever its type. The
/// pure check (<see cref="AccountBalanceRules"/>) finds the first end-of-day dip; every write that
/// moves money runs it over the candidate state through <c>AccountBalanceGuard</c> and refuses a
/// breach with the account, the balance and the date. Nothing is posted "anyway".
/// </summary>
public class AccountBalanceGuardTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly DateOnly Opening = LedgerFixtures.DefaultOpening; // 2026-01-01

    private static Transaction Transfer(
        Guid from, Guid to, decimal amount, DateOnly? departedOn, DateOnly? receivedOn, string owner = Owner) =>
        new()
        {
            OwnerId = owner, Type = TransactionType.Transfer, AccountId = from, TransferAccountId = to,
            Amount = amount, Currency = CurrencyCode.Eur, Payee = "Transfer",
            Date = departedOn ?? receivedOn ?? Opening, DepartedOn = departedOn, ReceivedOn = receivedOn,
        };

    private static Task<ValidationException> RefusedAsync(Func<Task> act) =>
        Assert.ThrowsAsync<ValidationException>(act);

    // ---- AccountBalanceRules.FirstShortfall (pure) --------------------------------------------

    [Fact]
    public void FirstShortfall_ReturnsTheFirstDayTheBalanceDipsBelowZero_AndThatBalance()
    {
        var account = new Account { OwnerId = Owner, Name = "Current", OpeningBalance = 100m, OpeningDate = Opening };
        var rows = new[]
        {
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 150m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 10), Payee = "Rent" },
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Income, Amount = 200m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 15), Payee = "Salary" },
            // A second, deeper dip later must not be the one reported.
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 400m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 3, 1), Payee = "Car" },
        };

        var shortfall = AccountBalanceRules.FirstShortfall(account, Opening, rows);

        shortfall.Should().NotBeNull();
        shortfall!.Date.Should().Be(new DateOnly(2026, 2, 10));
        shortfall.Balance.Should().Be(-50m);
    }

    [Fact]
    public void FirstShortfall_IsNull_WhenTheBalanceNeverDips_IncludingWhenItReachesExactlyZero()
    {
        var account = new Account { OwnerId = Owner, Name = "Current", OpeningBalance = 100m, OpeningDate = Opening };
        var rows = new[]
        {
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 60m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 10), Payee = "Rent" },
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 40m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 10), Payee = "Food" },
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Income, Amount = 5m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 11), Payee = "Refund" },
        };

        AccountBalanceRules.FirstShortfall(account, Opening, rows).Should().BeNull("zero is not below zero");
    }

    [Fact]
    public void FirstShortfall_DoesNotCountATransferReceiptStillPendingReview()
    {
        // Rule 72: a receipt with no departure is evidence, not money. Account B opens at 0 and
        // "receives" 100 with the departure unknown; a 50 payment afterwards still dips B to −50.
        var a = new Account { OwnerId = Owner, Name = "A", OpeningBalance = 500m, OpeningDate = Opening };
        var b = new Account { OwnerId = Owner, Name = "B", OpeningBalance = 0m, OpeningDate = Opening };
        var rows = new[]
        {
            Transfer(a.Id, b.Id, 100m, departedOn: null, receivedOn: new DateOnly(2026, 2, 1)),
            new Transaction { OwnerId = Owner, AccountId = b.Id, Type = TransactionType.Expense, Amount = 50m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 5), Payee = "Shop" },
        };

        var shortfall = AccountBalanceRules.FirstShortfall(b, Opening, rows, TransferLedger.PostingDates(rows));

        shortfall.Should().NotBeNull();
        shortfall!.Date.Should().Be(new DateOnly(2026, 2, 5));
        shortfall.Balance.Should().Be(-50m);

        // Once the departure is known the receipt is real money and B never dips.
        var posted = new[] { Transfer(a.Id, b.Id, 100m, departedOn: new DateOnly(2026, 1, 31), receivedOn: new DateOnly(2026, 2, 1)), rows[1] };
        AccountBalanceRules.FirstShortfall(b, Opening, posted, TransferLedger.PostingDates(posted)).Should().BeNull();
    }

    [Fact]
    public void FirstShortfall_IgnoresRowsBeforeTheOpeningDate()
    {
        // Rule 40: rows before the opening date are history only. A 500 payment in February
        // never counts against a 1 March opening of 100; the first real dip is the March row.
        var opening = new DateOnly(2026, 3, 1);
        var account = new Account { OwnerId = Owner, Name = "Current", OpeningBalance = 100m, OpeningDate = opening };
        var rows = new[]
        {
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 500m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 2, 15), Payee = "Old" },
            new Transaction { OwnerId = Owner, AccountId = account.Id, Type = TransactionType.Expense, Amount = 120m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 3, 5), Payee = "Shop" },
        };

        AccountBalanceRules.FirstShortfall(account, opening, new[] { rows[0] }).Should().BeNull();

        var shortfall = AccountBalanceRules.FirstShortfall(account, opening, rows);
        shortfall.Should().NotBeNull();
        shortfall!.Date.Should().Be(new DateOnly(2026, 3, 5));
        shortfall.Balance.Should().Be(-20m, "only the post-opening row moved the balance");
    }

    // ---- CreateTransaction --------------------------------------------------------------------

    [Fact]
    public async Task CreateExpense_ThatWouldTakeTheAccountBelowZero_IsRefused_NamingAccountBalanceAndDate()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);

        var ex = await RefusedAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 10), "Rent", 150m, TransactionType.Expense, null, account.Id),
            CancellationToken.None));

        var message = ex.Errors.Should().ContainKey("Amount").WhoseValue.Single();
        message.Should().Contain("Current").And.Contain("-50.00").And.Contain("2026-06-10");
        (await db.Transactions.CountAsync()).Should().Be(0, "a refused entry is not posted");
    }

    [Fact]
    public async Task CreateExpense_BackdatedIntoAPastDip_IsRefused_EvenThoughTodaysBalanceWouldBePositive()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);
        LedgerFixtures.Income(db, Owner, account.Id, 500m, new DateOnly(2026, 6, 15));

        // 100 + 500 − 150 = 450 today, but on 10 June the account only held 100.
        var ex = await RefusedAsync(() => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 10), "Rent", 150m, TransactionType.Expense, null, account.Id),
            CancellationToken.None));

        ex.Errors["Amount"].Single().Should().Contain("-50.00").And.Contain("2026-06-10");
        (await db.Transactions.CountAsync()).Should().Be(1, "only the seeded income exists");
    }

    [Fact]
    public async Task CreateExpense_ThatLeavesExactlyZero_IsAllowed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 10), "Rent", 100m, TransactionType.Expense, null, account.Id),
            CancellationToken.None);

        dto.AccountId.Should().Be(account.Id);
        (await db.Transactions.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task CreateExpense_WithNoAccount_IsNeverRefused()
    {
        await using var db = NewContext();
        LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 10m, type: AccountType.Current);

        var dto = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 10), "Cash purchase", 10_000m, TransactionType.Expense, null, AccountId: null),
            CancellationToken.None);

        dto.AccountId.Should().BeNull();
        var stored = await db.Transactions.SingleAsync();
        stored.AccountId.Should().BeNull();
        stored.Amount.Should().Be(10_000m);
    }

    // ---- DeleteTransaction --------------------------------------------------------------------

    [Fact]
    public async Task DeleteIncome_ThatLeavesALaterExpenseUncovered_IsRefused()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);
        var income = LedgerFixtures.Income(db, Owner, account.Id, 200m, new DateOnly(2026, 6, 1));
        LedgerFixtures.Expense(db, Owner, account.Id, 250m, new DateOnly(2026, 6, 10));

        var ex = await RefusedAsync(() => new DeleteTransactionCommandHandler(db, User)
            .Handle(new DeleteTransactionCommand(income.Id), CancellationToken.None));

        ex.Errors["TransactionId"].Single().Should().Contain("Current").And.Contain("-150.00").And.Contain("2026-06-10");
        (await db.Transactions.AsNoTracking().AnyAsync(t => t.Id == income.Id)).Should().BeTrue("the income still covers the payment");
    }

    [Fact]
    public async Task DeleteExpense_IsAlwaysAllowed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);
        LedgerFixtures.Income(db, Owner, account.Id, 200m, new DateOnly(2026, 6, 1));
        var expense = LedgerFixtures.Expense(db, Owner, account.Id, 250m, new DateOnly(2026, 6, 10));

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(expense.Id), CancellationToken.None);

        (await db.Transactions.AsNoTracking().AnyAsync(t => t.Id == expense.Id)).Should().BeFalse();
        (await db.Transactions.CountAsync()).Should().Be(1);
    }

    // ---- UpdateTransaction --------------------------------------------------------------------

    [Fact]
    public async Task UpdateIncome_ShrinkingItBelowWhatLaterExpensesNeed_IsRefused()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);
        var income = LedgerFixtures.Income(db, Owner, account.Id, 200m, new DateOnly(2026, 6, 1));
        LedgerFixtures.Expense(db, Owner, account.Id, 250m, new DateOnly(2026, 6, 10));

        var ex = await RefusedAsync(() => new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(income.Id, income.Date, "Employer", 100m, TransactionType.Income, account.Id),
            CancellationToken.None));

        ex.Errors["Amount"].Single().Should().Contain("Current").And.Contain("-50.00").And.Contain("2026-06-10");
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == income.Id)).Amount.Should().Be(200m, "the edit was not saved");

        // Shrinking to exactly what the payment needs is fine.
        var dto = await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(income.Id, income.Date, "Employer", 150m, TransactionType.Income, account.Id),
            CancellationToken.None);
        dto.Amount.Should().Be(150m);
    }

    [Fact]
    public async Task UpdateExpense_MovingItToAnAccountThatCannotCoverIt_IsRefused_NamingTheReceivingAccount()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 50m, type: AccountType.Current, order: 1);
        var expense = LedgerFixtures.Expense(db, Owner, a.Id, 200m, new DateOnly(2026, 6, 10));

        var ex = await RefusedAsync(() => new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(expense.Id, expense.Date, "Shop", 200m, TransactionType.Expense, b.Id),
            CancellationToken.None));

        ex.Errors["Amount"].Single().Should().Contain("B would be -150.00").And.Contain("2026-06-10");
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == expense.Id)).AccountId.Should().Be(a.Id);
    }

    [Fact]
    public async Task UpdateIncome_MovingItAwayFromAnAccountWhosePaymentsNeedIt_IsRefused_NamingTheAccountLeft()
    {
        // Both accounts are checked: the one losing the row as much as the one receiving it.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 0m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current, order: 1);
        var income = LedgerFixtures.Income(db, Owner, a.Id, 300m, new DateOnly(2026, 6, 1));
        LedgerFixtures.Expense(db, Owner, a.Id, 200m, new DateOnly(2026, 6, 10));

        var ex = await RefusedAsync(() => new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(income.Id, income.Date, "Employer", 300m, TransactionType.Income, b.Id),
            CancellationToken.None));

        ex.Errors["Amount"].Single().Should().Contain("A would be -200.00").And.Contain("2026-06-10");
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == income.Id)).AccountId.Should().Be(a.Id);
    }

    // ---- Transfers ----------------------------------------------------------------------------

    [Fact]
    public async Task CreateTransfer_WhoseDepartureWouldOverdrawTheSource_IsRefused()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 100m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current, order: 1);

        var ex = await RefusedAsync(() => new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(new DateOnly(2026, 6, 5), 150m, a.Id, b.Id), CancellationToken.None));

        ex.Errors["Amount"].Single().Should().Contain("A would be -50.00").And.Contain("2026-06-05");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task ConfirmTransferLegs_SupplyingADepartureThatOverdrawsTheSource_IsRefused_AndTheLegStaysUnknown()
    {
        // Rule 72: a receipt held for review is resolved by supplying the departure; that posts the
        // debit, so it must pass rule 74 like any other payment.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 100m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current, order: 1);
        var pending = Transfer(a.Id, b.Id, 150m, departedOn: null, receivedOn: new DateOnly(2026, 6, 5));
        db.Transactions.Add(pending);
        await db.SaveChangesAsync();

        var ex = await RefusedAsync(() => new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(pending.Id, DepartedOn: new DateOnly(2026, 6, 4)), CancellationToken.None));

        ex.Errors["DepartedOn"].Single().Should().Contain("A would be -50.00").And.Contain("2026-06-04");
        var stored = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == pending.Id);
        stored.DepartedOn.Should().BeNull("a refused confirmation changes nothing");
        stored.TransferStatus.Should().Be(TransferStatus.PendingReview);
    }

    [Fact]
    public async Task ConfirmTransferLegs_SupplyingOnlyAReceiptDate_IsNeverRefused()
    {
        // Confirming a receipt only adds money, so the guard is not consulted — even for a source
        // that (as legacy history) already sits below zero.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 100m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current, order: 1);
        var inTransit = Transfer(a.Id, b.Id, 150m, departedOn: new DateOnly(2026, 6, 4), receivedOn: null);
        db.Transactions.Add(inTransit);
        await db.SaveChangesAsync();

        var dto = await new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(inTransit.Id, ReceivedOn: new DateOnly(2026, 6, 6)), CancellationToken.None);

        dto.ReceivedOn.Should().Be(new DateOnly(2026, 6, 6));
        dto.TransferStatus.Should().Be(nameof(TransferStatus.Completed));
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == inTransit.Id)).ReceivedOn.Should().Be(new DateOnly(2026, 6, 6));
    }

    // ---- UpdateAccount ------------------------------------------------------------------------

    [Fact]
    public async Task UpdateAccount_LoweringTheOpeningBalanceBelowWhatRecordedPaymentsNeed_IsRefused()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 500m);
        LedgerFixtures.Expense(db, Owner, account.Id, 300m, new DateOnly(2026, 6, 10));

        var ex = await RefusedAsync(() => new UpdateAccountCommandHandler(db, User).Handle(
            new UpdateAccountCommand(account.Id, "Savings", AccountType.Savings, 200m, Opening), CancellationToken.None));

        ex.Errors["OpeningBalance"].Single().Should().Contain("Savings would be -100.00").And.Contain("2026-06-10");
        (await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id)).OpeningBalance.Should().Be(500m);

        // Exactly what the payment needs is allowed.
        var dto = await new UpdateAccountCommandHandler(db, User).Handle(
            new UpdateAccountCommand(account.Id, "Savings", AccountType.Savings, 300m, Opening), CancellationToken.None);
        dto.OpeningBalance.Should().Be(300m);
    }
}
