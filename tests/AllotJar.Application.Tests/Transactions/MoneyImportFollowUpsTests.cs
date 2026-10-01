using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Common;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// The 1 October 2026 follow-ups on money entry and import (D1, D8, D9, D10; Christopher chose the
/// recommended option for each): a typed amount with more decimals than cents is refused, never
/// rounded; a row moved by hand to another account is not offered again by its statement; a
/// purchase with refunds linked can't be split; an income deleted or lowered from under jars that
/// moved its money on is saved with a warning naming the backing deficit.
/// </summary>
public class MoneyImportFollowUpsTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep5 = new(2026, 9, 5);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);

    private static Dictionary<string, BudgetItem> SeedMonth(ApplicationDbContext db)
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 300m };
        var clothes = new BudgetItem { Name = "Clothes", PlannedAmount = 100m, DisplayOrder = 1 };
        var fees = new BudgetItem { Name = "Bank fees", PlannedAmount = 333.3333m, DisplayOrder = 2 };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries, clothes, fees } },
            },
        });
        db.SaveChanges();
        return new() { ["Groceries"] = groceries, ["Clothes"] = clothes, ["Fees"] = fees };
    }

    private static string Message(ValidationException ex, string key) => string.Join(" ", ex.Errors[key]);

    // --- D1: a typed amount is whole cents -------------------------------------------------------

    [Fact]
    public void D1_NewAmounts_WithAThirdDecimal_AreRefusedWithAMessage_NotRounded()
    {
        var account = Guid.NewGuid();
        var created = new CreateTransactionCommandValidator().Validate(
            new CreateTransactionCommand(Sep5, "Shop", 12.345m, TransactionType.Expense, null, account));
        created.IsValid.Should().BeFalse();
        created.Errors.Should().ContainSingle(e => e.PropertyName == "Amount").Which.ErrorMessage.Should().Be(MoneyInput.TooPrecise);

        new CreateTransactionCommandValidator().Validate(
                new CreateTransactionCommand(Sep5, "Shop", 12.34m, TransactionType.Expense, null, account))
            .IsValid.Should().BeTrue();
        new CreateTransactionCommandValidator().Validate(
                new CreateTransactionCommand(Sep5, "Shop", 12.340m, TransactionType.Expense, null, account))
            .IsValid.Should().BeTrue("12.340 is 12.34: nothing would be rounded");

        new CreateTransferCommandValidator().Validate(
                new CreateTransferCommand(Sep5, 100m, account, Guid.NewGuid(), Fee: 0.005m))
            .Errors.Should().ContainSingle(e => e.PropertyName == "Fee").Which.ErrorMessage.Should().Be(MoneyInput.TooPrecise);
        new AddBudgetItemCommandValidator().Validate(new AddBudgetItemCommand(Guid.NewGuid(), "Rent", PlannedAmount: 0.0001m))
            .IsValid.Should().BeFalse();
        new CreateTransactionCommandValidator().Validate(new CreateTransactionCommand(
                Sep5, "Pay", 100m, TransactionType.Income, null, account,
                JarAllocations: new[] { new JarAllocationInput(Guid.NewGuid(), 33.333m) }))
            .Errors.Should().ContainSingle(e => e.PropertyName == "JarAllocations").Which.ErrorMessage.Should().Be(MoneyInput.TooPrecise);
    }

    [Fact]
    public async Task D1_AnEdit_RefusesAChangedAmountWithAThirdDecimal_ButSavesAStoredOneUnchanged()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        // A converted amount restated at four decimals by the ForeignAmounts migration (P67).
        var row = LedgerFixtures.Expense(db, Owner, a.Id, 12.3456m, Sep5);
        db.ChangeTracker.Clear();

        var changed = () => new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, Sep5, "Shop", 12.345m, TransactionType.Expense, a.Id), Ct);
        Message((await changed.Should().ThrowAsync<ValidationException>()).Which, "Amount").Should().Be(MoneyInput.TooPrecise);

        // W10: the stored amount opened and saved unchanged (a new payee) stays as it is.
        var kept = await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, Sep5, "Corner shop", 12.3456m, TransactionType.Expense, a.Id), Ct);
        kept.Amount.Should().Be(12.3456m);

        // A planned amount the jar planner worked out (four decimals) also saves unchanged; a new one is whole cents.
        var plan = new UpdateBudgetItemCommandHandler(db, User);
        (await plan.Handle(new UpdateBudgetItemCommand(lines["Fees"].Id, 333.3333m), Ct)).Should().NotBeNull();
        var typed = () => plan.Handle(new UpdateBudgetItemCommand(lines["Fees"].Id, 333.333m), Ct);
        Message((await typed.Should().ThrowAsync<ValidationException>()).Which, "PlannedAmount").Should().Be(MoneyInput.TooPrecise);
        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Id == lines["Fees"].Id)).PlannedAmount.Should().Be(333.3333m);
    }

    [Fact]
    public async Task D1_SplitSlices_AreWholeCents_UnlessTheRowItselfCarriesMoreDecimals()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var cents = LedgerFixtures.Expense(db, Owner, a.Id, 10m, Sep5);
        var restated = LedgerFixtures.Expense(db, Owner, a.Id, 10.0005m, Sep5);
        db.ChangeTracker.Clear();
        var split = new SplitTransactionCommandHandler(db, User);

        var act = () => split.Handle(new SplitTransactionCommand(cents.Id, new[]
        {
            new SplitAllocationInput(lines["Groceries"].Id, 3.335m), new SplitAllocationInput(lines["Clothes"].Id, 6.665m),
        }), Ct);
        Message((await act.Should().ThrowAsync<ValidationException>()).Which, "Allocations").Should().Be(MoneyInput.TooPrecise);

        var dto = await split.Handle(new SplitTransactionCommand(restated.Id, new[]
        {
            new SplitAllocationInput(lines["Groceries"].Id, 5.0005m), new SplitAllocationInput(lines["Clothes"].Id, 5m),
        }), Ct);
        dto.Splits.Sum(s => s.Amount).Should().Be(10.0005m);
    }

    // --- D8: a row moved by hand is still its statement's entry ----------------------------------

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid accountId) =>
        new PreviewImportCommandHandler(db, User,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), Ct);

    private static Task<ImportStatementResult> CommitAsync(ApplicationDbContext db, Guid accountId, params CommitImportItem[] items) =>
        new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(accountId, items), Ct);

    private static string Camt(string reference, DateOnly date, decimal amount) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + $"<Ntry><Amt Ccy=\"EUR\">{amount:0.00}</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt>"
        + $"<AcctSvcrRef>{reference}</AcctSvcrRef>"
        + "<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>Shop</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>"
        + "</Stmt></BkToCstmrStmt></Document>";

    private static CommitImportItem Item(ImportCandidate row) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null);

    [Fact]
    public async Task D8_ARowMovedByHandToAnotherAccount_IsSkippedByItsStatement_AndStaysKnownWhenMovedBack()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 1000m, Sep1, AccountType.Current, order: 1);
        var xml = Camt("M-1", Sep10, 40m);
        var preview = await PreviewAsync(db, xml, a.Id);
        await CommitAsync(db, a.Id, Item(preview.Items[0]));
        var row = await db.Transactions.SingleAsync(t => t.BankReference == "M-1");
        db.ChangeTracker.Clear();

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, Sep10, "Shop", 40m, TransactionType.Expense, b.Id), Ct);
        db.ChangeTracker.Clear();
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == row.Id)).StatementAccountId.Should().Be(a.Id);

        var again = await PreviewAsync(db, xml, a.Id);
        again.NewCount.Should().Be(0, "the row was imported from this statement; the user only moved it");
        // A commit that still sends it (a stale screen) skips it too: the money is not posted twice.
        var commit = await CommitAsync(db, a.Id, Item(preview.Items[0]));
        commit.Imported.Should().Be(0);
        commit.SkippedDuplicates.Should().Be(1);
        (await db.Transactions.CountAsync(t => t.BankReference == "M-1")).Should().Be(1);

        // Moved on to no account and back home: still the one entry, and A knows it as before.
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, Sep10, "Shop", 40m, TransactionType.Expense, null), Ct);
        db.ChangeTracker.Clear();
        (await PreviewAsync(db, xml, a.Id)).NewCount.Should().Be(0);
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(row.Id, Sep10, "Shop", 40m, TransactionType.Expense, a.Id), Ct);
        db.ChangeTracker.Clear();
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == row.Id)).StatementAccountId.Should().BeNull();
        (await PreviewAsync(db, xml, a.Id)).NewCount.Should().Be(0);
    }

    // --- D9: a purchase with refunds linked is not split ----------------------------------------

    [Fact]
    public async Task D9_SplittingAPurchaseWithARefundLinked_IsRefusedAsDeleteIs_AndAllowedOnceUnlinked()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var lines = SeedMonth(db);
        var purchase = LedgerFixtures.Expense(db, Owner, a.Id, 100m, Sep10, lines["Groceries"].Id);
        var refund = LedgerFixtures.Income(db, Owner, a.Id, 20m, Sep12);
        await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(refund.Id, purchase.Id), Ct);
        db.ChangeTracker.Clear();
        var slices = new[] { new SplitAllocationInput(lines["Clothes"].Id, 60m), new SplitAllocationInput(lines["Fees"].Id, 40m) };

        var act = () => new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(purchase.Id, slices), Ct);

        Message((await act.Should().ThrowAsync<ValidationException>()).Which, "Allocations")
            .Should().Be("This purchase has a refund linked to it. Unlink the refund before splitting the purchase.");
        db.ChangeTracker.Clear();
        var unchanged = await db.Transactions.Include(t => t.Splits).AsNoTracking().SingleAsync(t => t.Id == purchase.Id);
        unchanged.Splits.Should().BeEmpty();
        unchanged.BudgetItemId.Should().Be(lines["Groceries"].Id);

        await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(refund.Id, null), Ct);
        db.ChangeTracker.Clear();
        var split = await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(purchase.Id, slices), Ct);
        split.Splits.Should().HaveCount(2);
    }

    // --- D10: an income taken from under jars that moved its money on ----------------------------

    private static (Account Savings, Jar Holiday, Jar Car) SeedJars(ApplicationDbContext db)
    {
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 0m, Sep1);
        Jar Goal(string name) => new()
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m,
            TargetDate = new DateOnly(2027, 7, 1), Accrual = AccrualMethod.TargetByDate, FundingAccountId = savings.Id,
        };
        var holiday = Goal("Holiday");
        var car = Goal("Car");
        db.Jars.AddRange(holiday, car);
        db.SaveChanges();
        return (savings, holiday, car);
    }

    /// <summary>500 received into Savings on 5 Sep, all of it into Holiday (rule 78), then moved on to Car on 10 Sep.</summary>
    private static async Task<Guid> IncomeMovedOnAsync(ApplicationDbContext db, Account savings, Jar holiday, Jar car)
    {
        var income = await new CreateTransactionCommandHandler(db, User).Handle(new CreateTransactionCommand(
            Sep5, "Employer", 500m, TransactionType.Income, null, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 500m, Sep10), Ct);
        db.ChangeTracker.Clear();
        return income.Id;
    }

    [Fact]
    public async Task D10_DeletingAnIncomeWhoseJarMoneyMovedOn_IsSaved_WithAWarningNamingTheDeficit()
    {
        await using var db = NewContext();
        var (savings, holiday, car) = SeedJars(db);
        var incomeId = await IncomeMovedOnAsync(db, savings, holiday, car);

        var result = await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(incomeId), Ct);

        (await db.Transactions.AnyAsync(t => t.Id == incomeId)).Should().BeFalse("the delete is saved, not refused");
        result.Warning.Should().Be(
            "Deleted. From 2026-09-10 Savings's jars hold 500 while the account holds 0, so 500 of the jars' money is not in the account. "
            + "Move that much out of a jar, or record the money that came in.");
        var ledger = (await JarLedgerReader.ReadAsync(db, Owner, Sep12, Ct)).Accounts[savings.Id];
        ledger.HasBackingDeficit.Should().BeTrue();
    }

    [Fact]
    public async Task D10_LoweringSuchAnIncome_IsSaved_WithTheWarning_WhileAnEditThatLeavesTheJarsBackedHasNone()
    {
        await using var db = NewContext();
        var (savings, holiday, car) = SeedJars(db);
        var incomeId = await IncomeMovedOnAsync(db, savings, holiday, car);

        var lowered = await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            incomeId, Sep5, "Employer", 200m, TransactionType.Income, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 200m) }), Ct);

        lowered.Amount.Should().Be(200m);
        lowered.Warning.Should().StartWith("Saved. From 2026-09-10 Savings's jars hold 500 while the account holds 200, so 300");
        db.ChangeTracker.Clear();

        // Raising it back leaves no deficit, and a plain rename says nothing either.
        var raised = await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            incomeId, Sep5, "Employer", 500m, TransactionType.Income, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        raised.Warning.Should().BeNull();
        db.ChangeTracker.Clear();
        var renamed = await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            incomeId, Sep5, "Salary", 500m, TransactionType.Income, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        renamed.Warning.Should().BeNull();
    }

    [Fact]
    public async Task D10_DeletingAnIncomeNoJarRelied_On_HasNoWarning()
    {
        await using var db = NewContext();
        var (savings, _, _) = SeedJars(db);
        var income = LedgerFixtures.Income(db, Owner, savings.Id, 300m, Sep5);
        db.ChangeTracker.Clear();

        var result = await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(income.Id), Ct);

        result.Warning.Should().BeNull();
    }
}
