using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Household.Queries.GetMemberIncome;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Refunds (rules 38/39, W12): a refund is money received linked to the purchase it comes back
/// from; both stay in history; it reduces net spending on the purchase's line in the month it
/// was received and is never income. Covers create-as-refund, marking existing income as a
/// refund and unmarking it, the line-direction rule (expense/savings lines only), the guards on
/// the original (an owned expense, dated on or before, never over-refunded), and the edits and
/// deletions a linked pair refuses.
/// </summary>
public class RefundTests
{
    private static readonly CurrentUserStub User = new("user-1");

    /// <summary>A month with Income/Salary and Household/Groceries (+ Clothes) lines. Returns the lines by name.</summary>
    private static Dictionary<string, BudgetItem> SeedMonth(ApplicationDbContext db, int year, int month, string owner = "user-1")
    {
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = 3000m };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var clothes = new BudgetItem { Name = "Clothes", PlannedAmount = 100m, DisplayOrder = 1 };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = owner, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { salary } },
                new() { Name = "Household", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { groceries, clothes } },
            },
        });
        db.SaveChanges();
        return new Dictionary<string, BudgetItem> { ["Salary"] = salary, ["Groceries"] = groceries, ["Clothes"] = clothes };
    }

    private static Transaction SeedExpense(ApplicationDbContext db, DateOnly date, decimal amount, Guid? lineId, string payee = "Shop", string owner = "user-1")
    {
        var t = new Transaction { OwnerId = owner, Date = date, Payee = payee, Amount = amount, Type = TransactionType.Expense, BudgetItemId = lineId };
        db.Transactions.Add(t);
        db.SaveChanges();
        return t;
    }

    private static Task<AllotJar.Application.Transactions.Dtos.TransactionDto> CreateRefund(
        ApplicationDbContext db, Guid originalId, DateOnly date, decimal amount, Guid? lineId = null, string payee = "Shop refund") =>
        new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(date, payee, amount, TransactionType.Income, lineId, RefundOfTransactionId: originalId),
            CancellationToken.None);

    private static async Task<AllotJar.Application.Budgets.Dtos.BudgetItemDto> Line(ApplicationDbContext db, int year, int month, string name)
    {
        var dto = await new GetBudgetMonthQueryHandler(db, User).Handle(new GetBudgetMonthQuery(year, month), CancellationToken.None);
        return dto.Categories.SelectMany(c => c.Items).Single(i => i.Name == name);
    }

    // ── Rule 38: 100 spent, 20 refunded → the line reads 80 net, both rows kept, the refund is not income.
    [Fact]
    public async Task Refund_LandsOnThePurchasesLine_AndNetsItsSpending()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);

        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);

        refund.Type.Should().Be(TransactionType.Income);
        refund.RefundOfTransactionId.Should().Be(purchase.Id);
        refund.RefundOfPayee.Should().Be("Shop");
        refund.RefundOfDate.Should().Be(new DateOnly(2026, 9, 10));
        refund.RefundOfAmount.Should().Be(100m);
        refund.BudgetItemId.Should().Be(lines["Groceries"].Id, "the refund follows the purchase onto its line by default");

        var groceries = await Line(db, 2026, 9, "Groceries");
        groceries.ActualAmount.Should().Be(80m);
        groceries.RefundedAmount.Should().Be(20m);
        (await Line(db, 2026, 9, "Salary")).ActualAmount.Should().Be(0m, "a refund is never income");

        var rows = await new GetTransactionsQueryHandler(db, User).Handle(new GetTransactionsQuery(2026, 9), CancellationToken.None);
        rows.Should().HaveCount(2, "both the purchase and the refund stay in history");
        var original = rows.Single(r => r.Id == purchase.Id);
        original.RefundCount.Should().Be(1);
        original.RefundedAmount.Should().Be(20m);
    }

    // ── Rule 39: purchase in September, refund in October → Sept 100, Oct −20 (combined 80); actual dates kept.
    [Fact]
    public async Task Refund_InALaterMonth_ReducesThatMonth_NotThePurchaseMonth()
    {
        await using var db = NewContext();
        var sept = SeedMonth(db, 2026, 9);
        SeedMonth(db, 2026, 10);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 25), 100m, sept["Groceries"].Id);

        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 10, 3), 20m);

        refund.Date.Should().Be(new DateOnly(2026, 10, 3));
        refund.BudgetItemMonth.Should().Be(10, "the default line is the Groceries line of the refund's own month");
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(100m);
        var october = await Line(db, 2026, 10, "Groceries");
        october.ActualAmount.Should().Be(-20m);
        october.RefundedAmount.Should().Be(20m);
    }

    [Fact]
    public async Task Refund_OfAnUncategorisedPurchase_StaysUncategorised_AndSkipsTheLearnedIncomeLine()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        // The payee has income history on the Salary line; a refund must not inherit it.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 9, 1), Payee = "Shop refund", Amount = 5m,
            Type = TransactionType.Income, BudgetItemId = lines["Salary"].Id,
        });
        db.SaveChanges();
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lineId: null);

        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);

        refund.BudgetItemId.Should().BeNull();
    }

    // ── Validator: a refund is recorded as income and is never split.
    [Fact]
    public void Validator_RequiresIncomeAndNoSplits_ForARefund()
    {
        var validator = new CreateTransactionCommandValidator();
        var original = Guid.NewGuid();

        var asExpense = validator.Validate(new CreateTransactionCommand(
            new DateOnly(2026, 9, 12), "Shop refund", 20m, TransactionType.Expense, null, RefundOfTransactionId: original));
        asExpense.Errors.Should().Contain(e => e.PropertyName == "Type" && e.ErrorMessage.Contains("money received"));

        var split = validator.Validate(new CreateTransactionCommand(
            new DateOnly(2026, 9, 12), "Shop refund", 20m, TransactionType.Income, null,
            Splits: new[] { new SplitAllocationInput(Guid.NewGuid(), 10m), new SplitAllocationInput(Guid.NewGuid(), 10m) },
            RefundOfTransactionId: original));
        split.Errors.Should().Contain(e => e.PropertyName == "Splits" && e.ErrorMessage.Contains("can't be split"));

        validator.Validate(new CreateTransactionCommand(
            new DateOnly(2026, 9, 12), "Shop refund", 20m, TransactionType.Income, null, RefundOfTransactionId: original))
            .IsValid.Should().BeTrue();
    }

    [Fact]
    public async Task Refund_OfIncomeOrTransferOrAnotherRefund_IsRefused()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var income = new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 1), Payee = "Pay", Amount = 3000m, Type = TransactionType.Income, BudgetItemId = lines["Salary"].Id };
        var a = new Account { OwnerId = "user-1", Name = "A" };
        var b = new Account { OwnerId = "user-1", Name = "B" };
        db.Accounts.AddRange(a, b);
        var transfer = new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 2), Payee = "Move", Amount = 50m, Type = TransactionType.Transfer, AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = new DateOnly(2026, 9, 2), ReceivedOn = new DateOnly(2026, 9, 2) };
        db.Transactions.AddRange(income, transfer);
        db.SaveChanges();
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);

        foreach (var (target, expected) in new[] { (income.Id, "money received"), (transfer.Id, "transfer"), (refund.Id, "can't itself be refunded") })
        {
            var act = () => CreateRefund(db, target, new DateOnly(2026, 9, 13), 5m);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single().Should().Contain(expected);
        }
    }

    [Fact]
    public async Task Refund_DatedBeforeThePurchase_IsRefused()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);

        var act = () => CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 9), 20m);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single()
            .Should().Contain("can't be dated before the purchase");
    }

    // ── Partial refunds add up, but never past the purchase.
    [Fact]
    public async Task Refunds_MayBePartial_ButNeverExceedThePurchase()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 60m);

        var tooMuch = () => CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 13), 50m);
        (await tooMuch.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single()
            .Should().Contain("110").And.Contain("60");

        await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 13), 40m);
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(0m);

        var rows = await new GetTransactionsQueryHandler(db, User).Handle(new GetTransactionsQuery(2026, 9), CancellationToken.None);
        rows.Single(r => r.Id == purchase.Id).RefundCount.Should().Be(2);
        rows.Single(r => r.Id == purchase.Id).RefundedAmount.Should().Be(100m);
    }

    [Fact]
    public async Task Refund_OfAnotherUsersPurchase_IsForbidden()
    {
        await using var db = NewContext();
        var theirs = SeedMonth(db, 2026, 9, owner: "user-2");
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, theirs["Groceries"].Id, owner: "user-2");
        SeedMonth(db, 2026, 9);

        var act = () => CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    // ── Direction: a refund goes on expense/savings lines, never on an income line.
    [Fact]
    public async Task Refund_CanBeAssignedToAnExpenseLine_ButNotAnIncomeLine()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);
        var assign = new AssignTransactionCommandHandler(db, User);

        var moved = await assign.Handle(new AssignTransactionCommand(refund.Id, lines["Clothes"].Id), CancellationToken.None);
        moved.BudgetItemName.Should().Be("Clothes");
        (await Line(db, 2026, 9, "Clothes")).ActualAmount.Should().Be(-20m);
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(100m);

        var toIncome = () => assign.Handle(new AssignTransactionCommand(refund.Id, lines["Salary"].Id), CancellationToken.None);
        (await toIncome.Should().ThrowAsync<ValidationException>()).Which.Errors["BudgetItemId"].Single()
            .Should().Contain("expense can only be assigned to expense lines");

        var atCreate = () => CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 13), 5m, lineId: lines["Salary"].Id);
        await atCreate.Should().ThrowAsync<ValidationException>();
    }

    // ── Marking money already received as a refund moves it off the income line onto the purchase's line.
    [Fact]
    public async Task LinkRefund_MovesIncomeOffTheIncomeLine_OntoThePurchasesLine()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var received = new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 12), Payee = "Shop", Amount = 20m, Type = TransactionType.Income, BudgetItemId = lines["Salary"].Id };
        db.Transactions.Add(received);
        db.SaveChanges();
        (await Line(db, 2026, 9, "Salary")).ActualAmount.Should().Be(20m);

        var dto = await new LinkRefundCommandHandler(db, User).Handle(
            new LinkRefundCommand(received.Id, purchase.Id), CancellationToken.None);

        dto.RefundOfTransactionId.Should().Be(purchase.Id);
        dto.BudgetItemId.Should().Be(lines["Groceries"].Id);
        (await Line(db, 2026, 9, "Salary")).ActualAmount.Should().Be(0m);
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(80m);
    }

    [Fact]
    public async Task LinkRefund_Unlinking_MakesItPlainIncomeAgain_OffTheExpenseLine()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);
        var handler = new LinkRefundCommandHandler(db, User);

        var plain = await handler.Handle(new LinkRefundCommand(refund.Id, null), CancellationToken.None);
        plain.RefundOfTransactionId.Should().BeNull();
        plain.BudgetItemId.Should().BeNull("an income row can't stay on an expense line");
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(100m);

        var onSalary = await handler.Handle(new LinkRefundCommand(refund.Id, null, lines["Salary"].Id), CancellationToken.None);
        onSalary.BudgetItemId.Should().Be(lines["Salary"].Id);
        (await Line(db, 2026, 9, "Salary")).ActualAmount.Should().Be(20m);
    }

    [Fact]
    public async Task LinkRefund_RefusesAPayment_ASplitRow_AndItself()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var payment = SeedExpense(db, new DateOnly(2026, 9, 11), 30m, lines["Clothes"].Id, payee: "Other");
        var handler = new LinkRefundCommandHandler(db, User);

        var asPayment = () => handler.Handle(new LinkRefundCommand(payment.Id, purchase.Id), CancellationToken.None);
        (await asPayment.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single().Should().Contain("Only money received");

        var split = new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 12), Payee = "Pay", Amount = 40m, Type = TransactionType.Income };
        db.Transactions.Add(split);
        db.SaveChanges();
        db.TransactionSplits.AddRange(
            new TransactionSplit { TransactionId = split.Id, BudgetItemId = lines["Salary"].Id, Amount = 20m },
            new TransactionSplit { TransactionId = split.Id, BudgetItemId = lines["Salary"].Id, Amount = 20m });
        db.SaveChanges();
        var asSplit = () => handler.Handle(new LinkRefundCommand(split.Id, purchase.Id), CancellationToken.None);
        (await asSplit.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single().Should().Contain("split");

        new LinkRefundCommandValidator().Validate(new LinkRefundCommand(purchase.Id, purchase.Id))
            .Errors.Should().Contain(e => e.ErrorMessage.Contains("itself"));
    }

    // ── Edits keep the pair coherent.
    [Fact]
    public async Task Update_RefusesTurningARefundIntoAPayment_OrShrinkingARefundedPurchaseBelowItsRefunds()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 60m);
        var update = new UpdateTransactionCommandHandler(db, User);

        var refundToExpense = () => update.Handle(
            new UpdateTransactionCommand(refund.Id, refund.Date, "Shop refund", 60m, TransactionType.Expense), CancellationToken.None);
        (await refundToExpense.Should().ThrowAsync<ValidationException>()).Which.Errors["Type"].Single().Should().Contain("refund is money received");

        var refundBackdated = () => update.Handle(
            new UpdateTransactionCommand(refund.Id, new DateOnly(2026, 9, 1), "Shop refund", 60m, TransactionType.Income), CancellationToken.None);
        (await refundBackdated.Should().ThrowAsync<ValidationException>()).Which.Errors[RefundRules.Key].Single().Should().Contain("dated before");

        var purchaseToIncome = () => update.Handle(
            new UpdateTransactionCommand(purchase.Id, purchase.Date, "Shop", 100m, TransactionType.Income), CancellationToken.None);
        (await purchaseToIncome.Should().ThrowAsync<ValidationException>()).Which.Errors["Type"].Single().Should().Contain("has refunds linked");

        var purchaseTooSmall = () => update.Handle(
            new UpdateTransactionCommand(purchase.Id, purchase.Date, "Shop", 50m, TransactionType.Expense), CancellationToken.None);
        (await purchaseTooSmall.Should().ThrowAsync<ValidationException>()).Which.Errors["Amount"].Single().Should().Contain("60");

        // Shrinking to exactly what was refunded is fine; the refund's payee edit is fine.
        var shrunk = await update.Handle(new UpdateTransactionCommand(purchase.Id, purchase.Date, "Shop", 60m, TransactionType.Expense), CancellationToken.None);
        shrunk.Amount.Should().Be(60m);
        var renamed = await update.Handle(new UpdateTransactionCommand(refund.Id, refund.Date, "Shop (returned)", 60m, TransactionType.Income), CancellationToken.None);
        renamed.RefundOfTransactionId.Should().Be(purchase.Id);
        renamed.BudgetItemId.Should().Be(lines["Groceries"].Id);
    }

    [Fact]
    public async Task Update_CountsARefundByItsConfirmedAmount_AndAWaitingRefundAsNothing()
    {
        // W08: a refund received as USD 60 and confirmed as €120 counts 120, so a €150 purchase may
        // shrink to €120 but not to €80. A refund still waiting for its euro amount counts nothing
        // yet, so the purchase it refunds is not held above its USD figure.
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var big = SeedExpense(db, new DateOnly(2026, 9, 10), 150m, lines["Groceries"].Id);
        var small = SeedExpense(db, new DateOnly(2026, 9, 11), 100m, lines["Groceries"].Id);
        db.Transactions.AddRange(
            new Transaction
            {
                OwnerId = "user-1", Date = new DateOnly(2026, 9, 12), Payee = "Shop refund", Amount = 120m, Currency = CurrencyCode.Eur,
                OriginalAmount = 60m, OriginalCurrency = CurrencyCode.From("USD"),
                Type = TransactionType.Income, RefundOfTransactionId = big.Id,
            },
            new Transaction
            {
                OwnerId = "user-1", Date = new DateOnly(2026, 9, 12), Payee = "Shop refund", Amount = 90m, Currency = CurrencyCode.From("USD"),
                FxPending = true, Type = TransactionType.Income, RefundOfTransactionId = small.Id,
            });
        await db.SaveChangesAsync();
        var update = new UpdateTransactionCommandHandler(db, User);

        var overRefunded = () => update.Handle(
            new UpdateTransactionCommand(big.Id, big.Date, "Shop", 80m, TransactionType.Expense), CancellationToken.None);
        (await overRefunded.Should().ThrowAsync<ValidationException>()).Which.Errors["Amount"].Single().Should().Contain("120");
        (await update.Handle(new UpdateTransactionCommand(big.Id, big.Date, "Shop", 120m, TransactionType.Expense), CancellationToken.None))
            .Amount.Should().Be(120m);

        (await update.Handle(new UpdateTransactionCommand(small.Id, small.Date, "Shop", 40m, TransactionType.Expense), CancellationToken.None))
            .Amount.Should().Be(40m);
    }

    [Fact]
    public async Task Delete_RefusesAPurchaseWithRefunds_ButDeletesARefund()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);
        var delete = new DeleteTransactionCommandHandler(db, User);

        var act = () => delete.Handle(new DeleteTransactionCommand(purchase.Id), CancellationToken.None);
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["TransactionId"].Single().Should().Contain("refund linked");

        await delete.Handle(new DeleteTransactionCommand(refund.Id), CancellationToken.None);
        (await Line(db, 2026, 9, "Groceries")).ActualAmount.Should().Be(100m);
        await delete.Handle(new DeleteTransactionCommand(purchase.Id), CancellationToken.None);
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Split_RefusesARefund()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = SeedExpense(db, new DateOnly(2026, 9, 10), 100m, lines["Groceries"].Id);
        var refund = await CreateRefund(db, purchase.Id, new DateOnly(2026, 9, 12), 20m);

        var act = () => new SplitTransactionCommandHandler(db, User).Handle(
            new SplitTransactionCommand(refund.Id, new[]
            {
                new SplitAllocationInput(lines["Groceries"].Id, 10m),
                new SplitAllocationInput(lines["Clothes"].Id, 10m),
            }), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Allocations"].Single().Should().Contain("can't be split");
    }

    // ── People: a refund attributed to a person lowers their spending and is never their income.
    [Fact]
    public async Task MemberFigures_NetRefundsOutOfSpending_AndLeaveThemOutOfIncome()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var alex = new HouseholdMember { OwnerId = "user-1", Name = "Alex", DisplayOrder = 0 };
        db.HouseholdMembers.Add(alex);
        lines["Salary"].MemberId = alex.Id;
        db.SaveChanges();
        db.Transactions.Add(new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 1), Payee = "Pay", Amount = 3000m, Type = TransactionType.Income, BudgetItemId = lines["Salary"].Id, MemberId = alex.Id });
        db.SaveChanges();
        var purchase = new Transaction { OwnerId = "user-1", Date = new DateOnly(2026, 9, 10), Payee = "Shop", Amount = 100m, Type = TransactionType.Expense, BudgetItemId = lines["Groceries"].Id, MemberId = alex.Id };
        db.Transactions.Add(purchase);
        db.SaveChanges();
        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(new DateOnly(2026, 9, 12), "Shop refund", 20m, TransactionType.Income, null, MemberId: alex.Id, RefundOfTransactionId: purchase.Id),
            CancellationToken.None);

        var spending = await new GetMemberSpendingQueryHandler(db, User).Handle(new GetMemberSpendingQuery(2026, 9), CancellationToken.None);
        spending.Single().Spent.Should().Be(80m);

        var income = await new GetMemberIncomeQueryHandler(db, User).Handle(new GetMemberIncomeQuery(2026, 9), CancellationToken.None);
        income.Items.Single().Received.Should().Be(3000m);
    }
}
