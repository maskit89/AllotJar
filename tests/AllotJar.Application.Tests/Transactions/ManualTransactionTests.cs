using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Manually created/deleted transactions, and the rule that assigning a
/// transaction to a line rolls it into that line's Spent.
/// </summary>
public class ManualTransactionTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    // Income(3000) + Housing(Rent planned 1000). Returns the Rent line id.
    private static Guid Seed(ApplicationDbContext db, string ownerId)
    {
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 1000m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Housing", Items = new List<BudgetItem> { rent } },
            },
        });
        db.SaveChanges();
        return rent.Id;
    }

    [Fact]
    public async Task Create_Assigned_AddsTransactionAndTracksTheLine()
    {
        await using var db = NewContext();
        var rentId = Seed(db, "user-1");
        var user = new CurrentUserStub("user-1");

        var dto = await new CreateTransactionCommandHandler(db, user).Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 6, 15), "Landlord", 750m, TransactionType.Expense, rentId),
            CancellationToken.None);

        dto.Payee.Should().Be("Landlord");
        dto.Amount.Should().Be(750m);
        dto.BudgetItemId.Should().Be(rentId);

        // The line rolls the 750 up as its spent.
        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        var rent = month.Categories.SelectMany(c => c.Items).Single(i => i.Id == rentId);
        rent.ActualAmount.Should().Be(750m);
    }

    [Fact]
    public async Task Create_Unassigned_AddsAStandaloneTransaction()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var user = new CurrentUserStub("user-1");

        var dto = await new CreateTransactionCommandHandler(db, user).Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 6, 1), "Cash", 20m, TransactionType.Expense, null),
            CancellationToken.None);

        dto.BudgetItemId.Should().BeNull();
        (await db.Transactions.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task Create_Throws_WhenAssigningToAnotherUsersLine()
    {
        await using var db = NewContext();
        var rentId = Seed(db, "user-1");
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new CreateTransactionCommand(
                    new DateOnly(2026, 6, 1), "x", 10m, TransactionType.Expense, rentId),
                CancellationToken.None));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public void Validator_RejectsNonPositiveAmount(decimal amount)
    {
        var validator = new CreateTransactionCommandValidator();
        var result = validator.Validate(new CreateTransactionCommand(
            new DateOnly(2026, 6, 1), "x", amount, TransactionType.Expense, null));
        result.IsValid.Should().BeFalse();
    }

    [Fact]
    public void Validator_RejectsTransferType()
    {
        // A bare Type=Transfer here would create a destination-less transfer that makes
        // money vanish from the derived account balances — transfers must go through the
        // two-account transfer flow.
        var validator = new CreateTransactionCommandValidator();
        validator.Validate(new CreateTransactionCommand(
                new DateOnly(2026, 6, 1), "x", 10m, TransactionType.Transfer, null))
            .IsValid.Should().BeFalse();
    }

    [Fact]
    public async Task Assign_RollsTheTransactionIntoTheLineActual()
    {
        await using var db = NewContext();
        var rentId = Seed(db, "user-1");
        var user = new CurrentUserStub("user-1");

        // A standalone transaction, then assigned to the (empty) Rent line.
        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 6, 10),
            Payee = "Landlord",
            Amount = 300m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        await new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(tx.Id, rentId), CancellationToken.None);

        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        var rent = month.Categories.SelectMany(c => c.Items).Single(i => i.Id == rentId);
        rent.ActualAmount.Should().Be(300m);
    }

    [Fact]
    public async Task Delete_RemovesTheTransaction()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var user = new CurrentUserStub("user-1");
        var tx = new Transaction { OwnerId = "user-1", Amount = 10m, Type = TransactionType.Expense };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        await new DeleteTransactionCommandHandler(db, user)
            .Handle(new DeleteTransactionCommand(tx.Id), CancellationToken.None);

        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Delete_Throws_WhenUserDoesNotOwnTheTransaction()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var tx = new Transaction { OwnerId = "user-1", Amount = 10m, Type = TransactionType.Expense };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        var handler = new DeleteTransactionCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new DeleteTransactionCommand(tx.Id), CancellationToken.None));
    }

    [Fact]
    public async Task Create_WithNoBudgetMonth_FallsBackToTheOwnersPreferredCurrency()
    {
        // Companion to #216's first-month rule: a date with no budget month used to stamp a
        // hardcoded EUR, which the account-currency invariant then rejected against a non-EUR
        // household's account — an un-budgeted month was unloggable for those users.
        await using var db = NewContext();
        var account = new Account
        {
            OwnerId = "user-1", Name = "Checking",
            Currency = AllotJar.Domain.ValueObjects.CurrencyCode.From("USD"),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();

        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync("user-1")
            .Returns(AllotJar.Domain.ValueObjects.CurrencyCode.From("USD"));

        var dto = await new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"), identity)
            .Handle(
                new CreateTransactionCommand(
                    new DateOnly(2027, 1, 15), "Grocer", 25m, TransactionType.Expense, null,
                    AccountId: account.Id),
                CancellationToken.None);

        dto.AccountId.Should().Be(account.Id);
        (await db.Transactions.SingleAsync()).Currency.Value.Should().Be("USD");
    }
}
