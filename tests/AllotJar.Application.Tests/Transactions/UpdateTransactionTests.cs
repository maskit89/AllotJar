using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

public class UpdateTransactionTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    private static Transaction Seed(ApplicationDbContext db, string ownerId)
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            Date = new DateOnly(2026, 6, 1),
            Payee = "Tesco",
            Amount = 20m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    [Fact]
    public async Task Update_ChangesTheCoreFields()
    {
        await using var db = NewContext();
        var tx = Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 6, 9), "Aldi", 31.50m, TransactionType.Expense),
            CancellationToken.None);

        dto.Payee.Should().Be("Aldi");
        dto.Amount.Should().Be(31.50m);
        dto.Date.Should().Be(new DateOnly(2026, 6, 9));
    }

    [Fact]
    public async Task Update_Throws_WhenUserDoesNotOwnTheTransaction()
    {
        await using var db = NewContext();
        var tx = Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 6, 9), "x", 1m, TransactionType.Expense),
                CancellationToken.None));
    }

    [Fact]
    public async Task Update_Throws_WhenNotFound()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(Guid.NewGuid(), new DateOnly(2026, 6, 9), "x", 1m, TransactionType.Expense),
                CancellationToken.None));
    }

    [Fact]
    public void Validator_RejectsNonPositiveAmount()
    {
        var validator = new UpdateTransactionCommandValidator();
        validator
            .Validate(new UpdateTransactionCommand(Guid.NewGuid(), new DateOnly(2026, 6, 1), "x", 0m, TransactionType.Expense))
            .IsValid.Should().BeFalse();
    }

    [Fact]
    public void Validator_RejectsTransferType()
    {
        // A transfer is only ever created/edited through the two-account transfer flow;
        // the generic edit must not be able to turn a row into a transfer.
        var validator = new UpdateTransactionCommandValidator();
        validator
            .Validate(new UpdateTransactionCommand(Guid.NewGuid(), new DateOnly(2026, 6, 1), "x", 10m, TransactionType.Transfer))
            .IsValid.Should().BeFalse();
    }

    [Fact]
    public async Task Update_NonAmountEdit_KeepsThePendingFlag()
    {
        // Renaming the payee changes nothing about the money: the row still waits for its
        // budget-currency amount (rule 44).
        await using var db = NewContext();
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "LNDN CAB 0042",
            Amount = 40m, Currency = CurrencyCode.From("GBP"),
            FxPending = true, Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new UpdateTransactionCommand(tx.Id, tx.Date, "London Cab", 40m, TransactionType.Expense),
            CancellationToken.None);

        var reloaded = await db.Transactions.SingleAsync(t => t.Id == tx.Id);
        reloaded.FxPending.Should().BeTrue();
    }

    [Fact]
    public async Task Update_ReTypingATransfer_ClearsTheDanglingCounterparty()
    {
        await using var db = NewContext();
        var from = new Account { OwnerId = "user-1", Name = "Current", Type = AccountType.Current, Currency = CurrencyCode.Eur };
        var to = new Account { OwnerId = "user-1", Name = "Savings", Type = AccountType.Current, Currency = CurrencyCode.Eur };
        db.Accounts.AddRange(from, to);
        await db.SaveChangesAsync();
        var transfer = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "Transfer",
            Amount = 50m, Type = TransactionType.Transfer,
            AccountId = from.Id, TransferAccountId = to.Id,
        };
        db.Transactions.Add(transfer);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        // Re-type the transfer into a plain expense (calling the handler directly, past
        // the validator that now blocks Type=Transfer): the stale destination link must
        // be cleared, or it keeps phantom-crediting the counterparty in derived balances.
        await handler.Handle(
            new UpdateTransactionCommand(transfer.Id, new DateOnly(2026, 6, 1), "Shop", 50m, TransactionType.Expense, from.Id),
            CancellationToken.None);

        var reloaded = await db.Transactions.SingleAsync(t => t.Id == transfer.Id);
        reloaded.Type.Should().Be(TransactionType.Expense);
        reloaded.TransferAccountId.Should().BeNull();
    }

    [Fact]
    public async Task Update_ReTypingATransfer_KeepsTheDestinationCovered()
    {
        // A opens with 100 and B with nothing; A's 100 reaches B and B spends it. Turning the
        // transfer into an expense on A takes B's receipt away: A alone still passes rule 74
        // (it lost the same 100 either way), so B is the account the guard must look at.
        await using var db = NewContext();
        var opening = new DateOnly(2026, 6, 1);
        var from = new Account { OwnerId = "user-1", Name = "Current", Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = 100m, OpeningDate = opening };
        var to = new Account { OwnerId = "user-1", Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur, OpeningBalance = 0m, OpeningDate = opening };
        db.Accounts.AddRange(from, to);
        var transfer = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 2), Payee = "Transfer", Amount = 100m, Type = TransactionType.Transfer,
            AccountId = from.Id, TransferAccountId = to.Id, DepartedOn = new DateOnly(2026, 6, 2), ReceivedOn = new DateOnly(2026, 6, 2),
        };
        var spent = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 3), Payee = "Shop", Amount = 100m, Type = TransactionType.Expense, AccountId = to.Id,
        };
        db.Transactions.AddRange(transfer, spent);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(
            new UpdateTransactionCommand(transfer.Id, new DateOnly(2026, 6, 2), "Shop", 100m, TransactionType.Expense, from.Id),
            CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Amount"].Single().Should().Contain("Savings").And.Contain("-100.00").And.Contain("2026-06-03");
        var reloaded = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == transfer.Id);
        reloaded.Type.Should().Be(TransactionType.Transfer);
        reloaded.TransferAccountId.Should().Be(to.Id);
        reloaded.ReceivedOn.Should().Be(new DateOnly(2026, 6, 2));

        // Without B's later spending the edit goes through, and B's leg is gone with the receipt.
        db.Transactions.Remove(spent);
        await db.SaveChangesAsync();
        var dto = await handler.Handle(
            new UpdateTransactionCommand(transfer.Id, new DateOnly(2026, 6, 2), "Shop", 100m, TransactionType.Expense, from.Id),
            CancellationToken.None);
        dto.Type.Should().Be(TransactionType.Expense);
        dto.TransferAccountId.Should().BeNull();
    }

    // --- Retained-assignment revalidation: an edit must never leave the transaction on a
    // line it could not be assigned to (expense line carrying income, or a silently
    // cross-month date). ------------------------------------------------------------------

    /// <summary>June 2026 with one expense line ("Rent"); returns the line.</summary>
    private static BudgetItem SeedJuneRentLine(ApplicationDbContext db, string ownerId)
    {
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 1000m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = 2026, Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Housing", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { rent } },
            },
        });
        db.SaveChanges();
        return rent;
    }

    private static Transaction SeedAssignedExpense(ApplicationDbContext db, string ownerId, Guid lineId)
    {
        var tx = new Transaction
        {
            OwnerId = ownerId, Date = new DateOnly(2026, 6, 10), Payee = "Landlord",
            Amount = 750m, Type = TransactionType.Expense, BudgetItemId = lineId,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    [Fact]
    public async Task Update_RejectsEditingAnAssignedExpenseIntoIncome_WhileKeepingTheExpenseLine()
    {
        // The old behavior kept the line: BudgetActuals then matched neither kind and the
        // amount silently vanished from every meaningful total.
        await using var db = NewContext();
        var rent = SeedJuneRentLine(db, "user-1");
        var tx = SeedAssignedExpense(db, "user-1", rent.Id);
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(tx.Id, tx.Date, "Refund", 750m, TransactionType.Income),
                CancellationToken.None));

        ex.Errors.Should().ContainKey("Type");
        (await db.Transactions.SingleAsync(t => t.Id == tx.Id)).Type.Should().Be(TransactionType.Expense);
    }

    [Fact]
    public async Task Update_MovingAnAssignedTransactionToAnotherMonth_NeedsTheCrossMonthAcknowledgment()
    {
        await using var db = NewContext();
        var rent = SeedJuneRentLine(db, "user-1");
        var tx = SeedAssignedExpense(db, "user-1", rent.Id);
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        // Silent cross-month move: rejected under the crossMonth key the client recognises.
        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 7, 2), "Landlord", 750m, TransactionType.Expense),
                CancellationToken.None));
        ex.Errors.Should().ContainKey("crossMonth");

        // The same edit, acknowledged after the confirm dialog: allowed, assignment retained.
        var dto = await handler.Handle(
            new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 7, 2), "Landlord", 750m, TransactionType.Expense,
                AcknowledgeCrossMonth: true),
            CancellationToken.None);
        dto.Date.Should().Be(new DateOnly(2026, 7, 2));
        dto.BudgetItemId.Should().Be(rent.Id);
    }

    [Fact]
    public async Task Update_UnrelatedEdit_DoesNotRePromptAnExistingCrossMonthAssignment()
    {
        // A deliberately-acknowledged cross-month assignment (dated July, budgeted to June)
        // must survive a payee/amount edit without demanding a fresh acknowledgment.
        await using var db = NewContext();
        var rent = SeedJuneRentLine(db, "user-1");
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 7, 1), Payee = "Landlord",
            Amount = 750m, Type = TransactionType.Expense, BudgetItemId = rent.Id,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new UpdateTransactionCommand(tx.Id, tx.Date, "Landlord GmbH", 760m, TransactionType.Expense),
            CancellationToken.None);

        dto.Payee.Should().Be("Landlord GmbH");
        dto.BudgetItemId.Should().Be(rent.Id);
    }

    [Fact]
    public async Task Update_MovingASplitTransactionToAnotherMonth_RevalidatesTheSlices()
    {
        await using var db = NewContext();
        var rent = SeedJuneRentLine(db, "user-1");
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 10), Payee = "Costco",
            Amount = 100m, Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = tx.Id, BudgetItemId = rent.Id, Amount = 100m });
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        // A same-month date edit is fine without any acknowledgment…
        await handler.Handle(
            new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 6, 12), "Costco", 100m, TransactionType.Expense),
            CancellationToken.None);

        // …but moving to July silently would leave the slices on June's actuals: rejected,
        // then allowed with the acknowledgment.
        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(
                new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 7, 3), "Costco", 100m, TransactionType.Expense),
                CancellationToken.None));
        ex.Errors.Should().ContainKey("crossMonth");

        var dto = await handler.Handle(
            new UpdateTransactionCommand(tx.Id, new DateOnly(2026, 7, 3), "Costco", 100m, TransactionType.Expense,
                AcknowledgeCrossMonth: true),
            CancellationToken.None);
        dto.Date.Should().Be(new DateOnly(2026, 7, 3));
    }
}
