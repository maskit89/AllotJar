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
    public async Task Update_AmountEdit_OnAPendingFxRow_ClearsThePendingFlag()
    {
        // A pending-FX row counts at face value; editing the amount is the user's manual fix.
        // The flag must clear, or a later reconcile pass would stamp a real rate onto the
        // corrected figure and double-convert it.
        await using var db = NewContext();
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "London Cab",
            Amount = 40m, Currency = CurrencyCode.From("GBP"), ExchangeRate = 1m,
            FxPending = true, Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();
        var handler = new UpdateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new UpdateTransactionCommand(tx.Id, tx.Date, "London Cab", 46m, TransactionType.Expense),
            CancellationToken.None);

        var reloaded = await db.Transactions.SingleAsync(t => t.Id == tx.Id);
        reloaded.FxPending.Should().BeFalse();
        reloaded.ExchangeRate.Should().Be(1m); // the corrected face value stands as-is
    }

    [Fact]
    public async Task Update_NonAmountEdit_KeepsThePendingFlag()
    {
        // Renaming the payee (amount unchanged) is not a correction of the face value —
        // the row stays pending so reconciliation can still fetch the real rate.
        await using var db = NewContext();
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "LNDN CAB 0042",
            Amount = 40m, Currency = CurrencyCode.From("GBP"), ExchangeRate = 1m,
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
}
