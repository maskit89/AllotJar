using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Commands.DeleteAccount;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
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
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-transfers-{Guid.NewGuid()}")
            .Options);

    private static Account SeedAccount(ApplicationDbContext db, string ownerId, string name, decimal opening)
    {
        var a = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = AccountType.Current,
            Currency = CurrencyCode.Eur,
            OpeningBalance = opening,
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    [Fact]
    public async Task Transfer_MovesBalance_OutOfSource_IntoDestination()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 100m);
        var to = SeedAccount(db, "user-1", "Savings", 0m);

        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, from.Id, to.Id), CancellationToken.None);

        var accounts = await new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);

        accounts.Single(a => a.Id == from.Id).CurrentBalance.Should().Be(70m); // 100 − 30
        accounts.Single(a => a.Id == to.Id).CurrentBalance.Should().Be(30m);   // 0 + 30
    }

    [Fact]
    public async Task Transfer_DoesNotCountAsIncomeInTheBudget()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 500m);
        var to = SeedAccount(db, "user-1", "Savings", 0m);
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 1000m } },
                },
            },
        });
        await db.SaveChangesAsync();

        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 200m, from.Id, to.Id), CancellationToken.None);

        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        var pay = month.Categories.Single(c => c.Kind == "Income").Items.Single();
        pay.ActualAmount.Should().Be(0m); // the transfer is not income
    }

    [Fact]
    public async Task DeleteAccount_ClearsTransfersPointingAtIt_AndKeepsTheTransaction()
    {
        await using var db = NewContext();
        var from = SeedAccount(db, "user-1", "Current", 100m);
        var to = SeedAccount(db, "user-1", "Savings", 0m);
        await new CreateTransferCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateTransferCommand(new DateOnly(2026, 6, 10), 30m, from.Id, to.Id), CancellationToken.None);

        await new DeleteAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new DeleteAccountCommand(to.Id), CancellationToken.None);

        var tx = db.Transactions.Single();
        tx.TransferAccountId.Should().BeNull(); // destination cleared
        tx.AccountId.Should().Be(from.Id);      // source still linked, survives
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
}
