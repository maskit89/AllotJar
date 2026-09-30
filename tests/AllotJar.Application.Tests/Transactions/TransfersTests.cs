using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Transfers move money between two of the user's accounts: out of the source, into
/// the destination. They affect account balances but never the budget (no line, not
/// income/expense).
/// </summary>
public class TransfersTests
{
    private static Account SeedAccount(ApplicationDbContext db, string ownerId, string name, decimal opening)
    {
        var a = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = AccountType.Current,
            Currency = CurrencyCode.Eur,
            OpeningBalance = opening,
            OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    // Deleting the destination account of a transfer is refused: the transfer keeps both
    // sides and both statement references (rule 51), so nothing is detached.
    [Fact]
    public async Task DeleteAccount_IsRefused_WhileATransferPointsAtIt()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 100m);
        var to = SeedAccount(db, "user-1", "Savings", 0m);
        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, from.Id, to.Id), CancellationToken.None);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            new DeleteAccountCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new DeleteAccountCommand(to.Id), CancellationToken.None));

        ex.Errors["Id"].Single().Should().Contain("Delete or re-record those transfers");
        var tx = db.Transactions.Single();
        tx.TransferAccountId.Should().Be(to.Id);
        tx.AccountId.Should().Be(from.Id);
        (await db.Accounts.CountAsync()).Should().Be(2);
    }

    [Fact]
    public void Validator_RejectsSameAccount_AndNonPositiveAmount()
    {
        var validator = new CreateTransferCommandValidator();
        var acct = Guid.NewGuid();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, acct, acct))
            .IsValid.Should().BeFalse();

        validator.Validate(new CreateTransferCommand(new DateOnly(2026, 6, 10), 0m, Guid.NewGuid(), Guid.NewGuid()))
            .IsValid.Should().BeFalse();
    }

    private static Account SeedAccountIn(ApplicationDbContext db, string ownerId, string name, string currency)
    {
        var a = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = AccountType.Current,
            Currency = CurrencyCode.From(currency),
            OpeningBalance = 1000m,
            OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    [Fact]
    public async Task Transfer_BetweenDifferentCurrencies_IsRejected_AndMovesNothing()
    {
        await using var db = NewContext();
        var eur = SeedAccountIn(db, "user-1", "Current", "EUR");
        var gbp = SeedAccountIn(db, "user-1", "UK", "GBP");
        var handler = new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"));

        // Without a conversion this would credit £30 for €30 debited — silent net-worth
        // change. It must be refused, and no row written.
        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, eur.Id, gbp.Id), CancellationToken.None));

        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Transfer_StampsCurrencyFromSource_NotHardcodedEur()
    {
        await using var db = NewContext();
        var from = SeedAccountIn(db, "user-1", "UK Current", "GBP");
        var to = SeedAccountIn(db, "user-1", "UK Savings", "GBP");

        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, from.Id, to.Id), CancellationToken.None);

        db.Transactions.Single().Currency.Should().Be(CurrencyCode.From("GBP"));
    }
}
