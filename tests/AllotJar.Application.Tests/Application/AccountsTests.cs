using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Accounts and their read-time-derived balances: opening balance plus every assigned
/// transaction (income adds, expense subtracts), owner-scoped; deleting an account
/// leaves its transactions in place but unlinked.
/// </summary>
public class AccountsTests
{
    private static Account SeedAccount(ApplicationDbContext db, string ownerId, decimal opening, int order = 0)
    {
        var account = new Account
        {
            OwnerId = ownerId,
            Name = "Everyday",
            Type = AccountType.Current,
            Currency = CurrencyCode.Eur,
            OpeningBalance = opening,
            OpeningDate = new DateOnly(2026, 1, 1),
            DisplayOrder = order,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static void AddTx(
        ApplicationDbContext db, string ownerId, Guid? accountId, decimal amount, TransactionType type)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId,
            AccountId = accountId,
            Amount = amount,
            Type = type,
            Date = new DateOnly(2026, 6, 10),
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task GetAccounts_DerivesBalance_FromOpeningPlusAssignedTransactions()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1", opening: 100m);
        AddTx(db, "user-1", account.Id, 50m, TransactionType.Income);   // +50
        AddTx(db, "user-1", account.Id, 30m, TransactionType.Expense);  // −30
        AddTx(db, "user-1", accountId: null, 999m, TransactionType.Expense); // unassigned — ignored

        var handler = new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetAccountsQuery(), CancellationToken.None);

        result.Should().ContainSingle();
        result[0].OpeningBalance.Should().Be(100m);
        result[0].CurrentBalance.Should().Be(120m); // 100 + 50 − 30
    }

    [Fact]
    public async Task GetAccounts_AreOwnerScoped()
    {
        await using var db = NewContext();
        SeedAccount(db, "user-1", opening: 10m);
        SeedAccount(db, "user-2", opening: 99m);

        var handler = new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetAccountsQuery(), CancellationToken.None);

        result.Should().ContainSingle();
        result[0].OpeningBalance.Should().Be(10m);
    }

    [Fact]
    public async Task CreateAccount_OrdersAfterExisting_AndBalanceStartsAtOpening()
    {
        await using var db = NewContext();
        SeedAccount(db, "user-1", opening: 0m, order: 0);

        var handler = new CreateAccountCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new CreateAccountCommand("Savings", AccountType.Savings, "EUR", 500m, new DateOnly(2026, 1, 1)), CancellationToken.None);

        dto.DisplayOrder.Should().Be(1);
        dto.CurrentBalance.Should().Be(500m);
        dto.Currency.Should().Be("EUR");
    }

    [Fact]
    public async Task DeleteAccount_UnlinksItsTransactions_ButKeepsThem()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1", opening: 0m);
        AddTx(db, "user-1", account.Id, 40m, TransactionType.Expense);

        var handler = new DeleteAccountCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new DeleteAccountCommand(account.Id), CancellationToken.None);

        db.Accounts.Should().BeEmpty();
        var tx = db.Transactions.Single();
        tx.AccountId.Should().BeNull(); // survives, just unlinked
    }
}
