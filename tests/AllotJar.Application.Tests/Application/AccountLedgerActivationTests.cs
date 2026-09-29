using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The account endpoints now read through the dated actual-money ledger (W01/W07 activation):
/// opening balance at the start of its date (rule 40), unavailable before it (rule 67), one bank
/// leg per transfer side with money in transit between them (rules 69/71), and receipt-first
/// transfers held for review with no posted effect (rule 72). Expected figures are computed by
/// hand from the agreed examples, not from the production formula.
/// </summary>
public class AccountLedgerActivationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new("user-1");
    private static readonly DateOnly Opening = new(2026, 9, 1);

    private static Account SeedAccount(
        ApplicationDbContext db, string name, decimal opening, DateOnly? openingDate,
        string owner = "user-1", AccountType type = AccountType.Current)
    {
        var account = new Account
        {
            OwnerId = owner, Name = name, Type = type, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = openingDate,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static void SeedMovement(ApplicationDbContext db, Account account, TransactionType type, decimal amount, DateOnly date)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = account.OwnerId, AccountId = account.Id, Type = type, Amount = amount,
            Currency = CurrencyCode.Eur, Date = date, Payee = type.ToString(),
        });
        db.SaveChanges();
    }

    private static Transaction SeedPendingReceipt(ApplicationDbContext db, Account from, Account to, decimal amount, DateOnly receivedOn)
    {
        // What a receiving-statement import records: the receipt leg only (rule 72).
        var transfer = new Transaction
        {
            OwnerId = from.OwnerId, AccountId = from.Id, TransferAccountId = to.Id,
            Type = TransactionType.Transfer, Amount = amount, Currency = CurrencyCode.Eur,
            Date = receivedOn, ReceivedOn = receivedOn, DepartedOn = null,
            ReceiptBankReference = "B-STMT-1", Payee = "TRANSFER FROM A",
        };
        db.Transactions.Add(transfer);
        db.SaveChanges();
        return transfer;
    }

    private static async Task<Dictionary<Guid, AllotJar.Application.Accounts.Dtos.AccountDto>> AccountsAsOf(
        ApplicationDbContext db, DateOnly asOf) =>
        (await new GetAccountsQueryHandler(db, User).Handle(new GetAccountsQuery(asOf), CancellationToken.None))
        .ToDictionary(a => a.Id);

    // ── Rule 40: the opening balance already includes everything before its date.
    [Fact]
    public async Task OpeningBalance_AppliesFromTheStartOfItsDate_AndEarlierHistoryNeverAddsAgain()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 1000m, Opening);
        SeedMovement(db, account, TransactionType.Income, 200m, new DateOnly(2026, 8, 15)); // already inside the 1,000
        SeedMovement(db, account, TransactionType.Expense, 50m, new DateOnly(2026, 9, 10));

        var view = (await AccountsAsOf(db, new DateOnly(2026, 9, 30)))[account.Id];

        view.CurrentBalance.Should().Be(950m, "1,000 opening − 50; the August deposit must not become 1,200");
        view.OpeningDate.Should().Be(Opening);
        view.BalanceAsOf.Should().Be(new DateOnly(2026, 9, 30));

        // The August deposit remains available as history.
        var register = await new GetTransactionsQueryHandler(db, User)
            .Handle(new GetTransactionsQuery(2026, 8, false), CancellationToken.None);
        register.Should().ContainSingle(t => t.Amount == 200m);
    }

    // ── Rule 67: before the opening date the balance is unavailable, not zero.
    [Fact]
    public async Task BalanceBeforeTheOpeningDate_IsUnavailable_NotZero()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 1000m, Opening);

        var view = (await AccountsAsOf(db, new DateOnly(2026, 8, 31)))[account.Id];

        view.CurrentBalance.Should().BeNull();
        view.OpeningDateMissing.Should().BeFalse();
        view.BalanceAsOf.Should().Be(new DateOnly(2026, 8, 31));
    }

    [Fact]
    public async Task AccountWithoutAnOpeningDate_ReportsUnavailable_WithoutInferringOne()
    {
        await using var db = NewContext();
        var legacy = SeedAccount(db, "Old savings", 300m, openingDate: null);
        SeedMovement(db, legacy, TransactionType.Income, 50m, new DateOnly(2026, 9, 5));

        var view = (await AccountsAsOf(db, new DateOnly(2026, 9, 30)))[legacy.Id];

        view.CurrentBalance.Should().BeNull("no opening date means no calculable balance");
        view.OpeningDateMissing.Should().BeTrue();
        view.OpeningBalance.Should().Be(300m); // the recorded amount is still shown as data
    }

    [Fact]
    public async Task MovementsDatedAfterTheAsOfDate_DoNotCountYet()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 1000m, Opening);
        SeedMovement(db, account, TransactionType.Expense, 80m, new DateOnly(2026, 10, 5));

        (await AccountsAsOf(db, new DateOnly(2026, 9, 30)))[account.Id].CurrentBalance.Should().Be(1000m);
        (await AccountsAsOf(db, new DateOnly(2026, 10, 5)))[account.Id].CurrentBalance.Should().Be(920m);
    }

    [Fact]
    public async Task CreateAccount_RequiresAnOpeningDate_AndReportsTheBalanceAsOfToday()
    {
        var validation = new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Pot", AccountType.Savings, "EUR", 100m, null));
        validation.IsValid.Should().BeFalse();
        validation.Errors.Should().ContainSingle(e => e.PropertyName == "OpeningDate");

        await using var db = NewContext();
        var handler = new CreateAccountCommandHandler(db, User);
        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new CreateAccountCommand("Pot", AccountType.Savings, "EUR", 100m, null), CancellationToken.None));
        (await db.Accounts.CountAsync()).Should().Be(0);

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var open = await handler.Handle(
            new CreateAccountCommand("Pot", AccountType.Savings, "EUR", 100m, today), CancellationToken.None);
        open.CurrentBalance.Should().Be(100m);
        open.OpeningDate.Should().Be(today);

        // An opening dated tomorrow has no balance today — rule 67, not a pretend zero.
        var future = await handler.Handle(
            new CreateAccountCommand("Later", AccountType.Savings, "EUR", 100m, today.AddDays(1)), CancellationToken.None);
        future.CurrentBalance.Should().BeNull();
        future.OpeningDateMissing.Should().BeFalse();
    }

    // ── Rules 69/71: departure debits the source on its date; the destination is credited only on
    // confirmed receipt; between the two the money is in transit and the total is conserved.
    [Fact]
    public async Task Transfer_DebitsTheSourceOnDeparture_AndCreditsTheDestinationOnlyOnConfirmedReceipt()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening, type: AccountType.Savings);
        var departure = new DateOnly(2026, 9, 30);
        var receipt = new DateOnly(2026, 10, 1);

        var transfer = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(departure, 100m, a.Id, b.Id), CancellationToken.None);
        transfer.TransferStatus.Should().Be("InTransit");
        transfer.DepartedOn.Should().Be(departure);
        transfer.ReceivedOn.Should().BeNull();
        transfer.Date.Should().Be(departure);

        var before = await AccountsAsOf(db, new DateOnly(2026, 9, 29));
        before[a.Id].CurrentBalance.Should().Be(1000m);
        before[b.Id].CurrentBalance.Should().Be(200m);

        var inTransit = await AccountsAsOf(db, departure);
        inTransit[a.Id].CurrentBalance.Should().Be(900m);
        inTransit[b.Id].CurrentBalance.Should().Be(200m, "no arrival date is invented");
        inTransit[a.Id].InTransitOut.Should().Be(100m);
        inTransit[b.Id].InTransitIn.Should().Be(100m);
        (inTransit[a.Id].CurrentBalance + inTransit[b.Id].CurrentBalance + inTransit[a.Id].InTransitOut).Should().Be(1200m);

        var confirmed = await new ConfirmTransferLegsCommandHandler(db, User)
            .Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: receipt), CancellationToken.None);
        confirmed.TransferStatus.Should().Be("Completed");

        var arrived = await AccountsAsOf(db, receipt);
        arrived[a.Id].CurrentBalance.Should().Be(900m);
        arrived[b.Id].CurrentBalance.Should().Be(300m);
        arrived[a.Id].InTransitOut.Should().Be(0m);
        arrived[b.Id].InTransitIn.Should().Be(0m);

        // September's history is not rewritten by October's confirmation.
        var septemberAgain = await AccountsAsOf(db, departure);
        septemberAgain[b.Id].CurrentBalance.Should().Be(200m);
        septemberAgain[b.Id].InTransitIn.Should().Be(100m);
    }

    // ── Rule 72: A 500 / B 200 with a 100 receipt into B must not become A 500 / B 300.
    [Fact]
    public async Task PendingReceipt_IsHeldForReview_WithNoPostedEffect_UntilDepartureIsSupplied()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 500m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening, type: AccountType.Savings);
        var pending = SeedPendingReceipt(db, a, b, 100m, receivedOn: new DateOnly(2026, 10, 1));

        var held = await AccountsAsOf(db, new DateOnly(2026, 10, 5));
        held[a.Id].CurrentBalance.Should().Be(500m);
        held[b.Id].CurrentBalance.Should().Be(200m);
        held[b.Id].PendingReceiptCount.Should().Be(1);
        held[b.Id].PendingReceiptTotal.Should().Be(100m);
        held[b.Id].RequiresReview.Should().BeTrue();
        held[a.Id].RequiresReview.Should().BeTrue("both accounts disclose the incomplete transfer");
        held[a.Id].InTransitOut.Should().Be(0m, "a pending receipt is not money in transit");
        held[b.Id].InTransitIn.Should().Be(0m);

        var register = await new GetTransactionsQueryHandler(db, User)
            .Handle(new GetTransactionsQuery(null, null, false), CancellationToken.None);
        register.Single().TransferStatus.Should().Be("PendingReview");
        register.Single().ReceiptBankReference.Should().Be("B-STMT-1");

        var resolved = await new ConfirmTransferLegsCommandHandler(db, User)
            .Handle(new ConfirmTransferLegsCommand(pending.Id, DepartedOn: new DateOnly(2026, 9, 30)), CancellationToken.None);
        resolved.TransferStatus.Should().Be("Completed");
        resolved.Date.Should().Be(new DateOnly(2026, 9, 30), "the register sorts a resolved receipt by its departure");

        var onDeparture = await AccountsAsOf(db, new DateOnly(2026, 9, 30));
        onDeparture[a.Id].CurrentBalance.Should().Be(400m);
        onDeparture[b.Id].CurrentBalance.Should().Be(200m);
        onDeparture[b.Id].InTransitIn.Should().Be(100m);

        var afterReceipt = await AccountsAsOf(db, new DateOnly(2026, 10, 5));
        afterReceipt[a.Id].CurrentBalance.Should().Be(400m);
        afterReceipt[b.Id].CurrentBalance.Should().Be(300m);
        afterReceipt[b.Id].PendingReceiptCount.Should().Be(0);
        afterReceipt[b.Id].RequiresReview.Should().BeFalse();
    }

    [Fact]
    public async Task ConfirmTransferLegs_FillsOnlyUnknownLegs_AndRefusesToRewriteAConfirmedOne()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening);
        var departure = new DateOnly(2026, 9, 30);
        var transfer = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(departure, 100m, a.Id, b.Id), CancellationToken.None);
        var handler = new ConfirmTransferLegsCommandHandler(db, User);

        // A repeat of the confirmed departure is harmless; a different date is refused.
        (await handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, DepartedOn: departure), CancellationToken.None))
            .DepartedOn.Should().Be(departure);
        var rewrite = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, DepartedOn: new DateOnly(2026, 9, 29)), CancellationToken.None));
        rewrite.Errors.Should().ContainKey("DepartedOn");

        // References attach to their leg once; a case variant of the same reference is a repeat.
        await handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, BankReference: "A-STMT-7"), CancellationToken.None);
        await handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, BankReference: "a-stmt-7"), CancellationToken.None);
        var otherRef = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, BankReference: "A-STMT-8"), CancellationToken.None));
        otherRef.Errors.Should().ContainKey("BankReference");

        // Receipt fills once; a later different receipt is refused and leaves the first intact.
        var receipt = new DateOnly(2026, 10, 1);
        await handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: receipt, ReceiptBankReference: "B-STMT-3"), CancellationToken.None);
        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: receipt.AddDays(1)), CancellationToken.None));

        var stored = await db.Transactions.SingleAsync();
        stored.DepartedOn.Should().Be(departure);
        stored.ReceivedOn.Should().Be(receipt);
        stored.BankReference.Should().Be("A-STMT-7");
        stored.ReceiptBankReference.Should().Be("B-STMT-3");
    }

    [Fact]
    public async Task ConfirmTransferLegs_RejectsReceiptBeforeDeparture_NonTransfers_AndOtherHouseholds()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening);
        var transfer = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(new DateOnly(2026, 9, 30), 100m, a.Id, b.Id), CancellationToken.None);
        var handler = new ConfirmTransferLegsCommandHandler(db, User);

        var early = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: new DateOnly(2026, 9, 29)), CancellationToken.None));
        early.Errors.Should().ContainKey("ReceivedOn");
        (await db.Transactions.SingleAsync()).ReceivedOn.Should().BeNull();

        SeedMovement(db, a, TransactionType.Expense, 5m, new DateOnly(2026, 9, 2));
        var expense = await db.Transactions.SingleAsync(t => t.Type == TransactionType.Expense);
        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new ConfirmTransferLegsCommand(expense.Id, ReceivedOn: new DateOnly(2026, 9, 3)), CancellationToken.None));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            new ConfirmTransferLegsCommandHandler(db, new CurrentUserStub("intruder"))
                .Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: new DateOnly(2026, 10, 1)), CancellationToken.None));

        new ConfirmTransferLegsCommandValidator()
            .Validate(new ConfirmTransferLegsCommand(transfer.Id))
            .IsValid.Should().BeFalse("confirming nothing is a client error");
    }

    [Fact]
    public void CreateTransferValidator_RejectsAReceiptBeforeTheDeparture()
    {
        var validator = new CreateTransferCommandValidator();
        var ok = validator.Validate(new CreateTransferCommand(
            new DateOnly(2026, 9, 30), 10m, Guid.NewGuid(), Guid.NewGuid(), ReceivedOn: new DateOnly(2026, 9, 30)));
        ok.IsValid.Should().BeTrue();

        var early = validator.Validate(new CreateTransferCommand(
            new DateOnly(2026, 9, 30), 10m, Guid.NewGuid(), Guid.NewGuid(), ReceivedOn: new DateOnly(2026, 9, 29)));
        early.IsValid.Should().BeFalse();
        early.Errors.Should().ContainSingle(e => e.PropertyName == "ReceivedOn");
    }

    [Fact]
    public async Task EditingATransferIntoAnExpense_ClearsItsBankLegs()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening);
        var transfer = await new CreateTransferCommandHandler(db, User)
            .Handle(new CreateTransferCommand(new DateOnly(2026, 9, 30), 100m, a.Id, b.Id, ReceivedOn: new DateOnly(2026, 10, 1)),
                CancellationToken.None);

        var edited = await new UpdateTransactionCommandHandler(db, User)
            .Handle(new UpdateTransactionCommand(transfer.Id, new DateOnly(2026, 9, 30), "Fee", 100m, TransactionType.Expense, a.Id),
                CancellationToken.None);

        edited.TransferStatus.Should().BeNull();
        var stored = await db.Transactions.SingleAsync();
        stored.TransferAccountId.Should().BeNull();
        stored.DepartedOn.Should().BeNull();
        stored.ReceivedOn.Should().BeNull();
        stored.ReceiptBankReference.Should().BeNull();

        var views = await AccountsAsOf(db, new DateOnly(2026, 10, 5));
        views[a.Id].CurrentBalance.Should().Be(900m);
        views[b.Id].CurrentBalance.Should().Be(200m, "the former destination no longer receives anything");
    }

    [Fact]
    public async Task Reconciliation_ReportsUnavailableBalances_AndTheReviewFlag()
    {
        await using var db = NewContext();
        var legacy = SeedAccount(db, "Old pot", 300m, openingDate: null, type: AccountType.Savings);
        var a = SeedAccount(db, "A", 500m, Opening);
        var b = SeedAccount(db, "B", 200m, Opening, type: AccountType.Savings);
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Holiday", FundingAccountId = legacy.Id });
        db.SaveChanges();
        SeedPendingReceipt(db, a, b, 100m, receivedOn: new DateOnly(2026, 9, 20));

        var rows = (await new GetAccountReconciliationQueryHandler(db, User)
                .Handle(new GetAccountReconciliationQuery(new DateOnly(2026, 9, 30)), CancellationToken.None))
            .ToDictionary(r => r.AccountId);

        rows[legacy.Id].CurrentBalance.Should().BeNull();
        rows[legacy.Id].Float.Should().BeNull("no balance, no float — not a fabricated shortfall");
        rows[legacy.Id].BackedJarCount.Should().Be(1);
        rows[legacy.Id].BackedJarsTotal.Should().Be(0m, "an unavailable ledger counts no jar money (rule 67)");
        rows[b.Id].CurrentBalance.Should().Be(200m);
        rows[b.Id].Float.Should().Be(200m);
        rows[b.Id].RequiresReview.Should().BeTrue();
        rows[a.Id].RequiresReview.Should().BeTrue();
    }
}
