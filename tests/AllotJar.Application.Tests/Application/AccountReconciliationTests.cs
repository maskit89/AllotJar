using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Per-account reconciliation: an account's derived balance vs the sinking funds it
/// backs (those naming it as their funding account), and the resulting float.
/// </summary>
public class AccountReconciliationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-recon-{Guid.NewGuid()}")
            .Options);

    [Fact]
    public async Task Reconciles_AccountBalance_AgainstBackedJarBalances()
    {
        await using var db = NewContext();

        var account = new Account
        {
            OwnerId = "user-1", Name = "Savings Joint", Type = AccountType.Savings,
            Currency = CurrencyCode.Eur, OpeningBalance = 1000m,
        };
        db.Accounts.Add(account);
        db.SaveChanges();

        // The account holds 1000. A fund it backs has opening 200 + a 100 contribution = 300.
        var fundId = Guid.NewGuid();
        db.Jars.Add(new Jar
        {
            Id = fundId, OwnerId = "user-1", Name = "Holiday", TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, OpeningBalance = 200m, FundingAccountId = account.Id,
        });
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Holiday", SavingsId = fundId, PlannedAmount = 100m } } },
            },
        });
        db.SaveChanges();

        var result = await new GetAccountReconciliationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None);

        var recon = result.Single();
        recon.CurrentBalance.Should().Be(1000m);
        recon.BackedJarsTotal.Should().Be(300m); // opening 200 + contribution 100
        recon.BackedJarCount.Should().Be(1);
        recon.Float.Should().Be(700m); // 1000 − 300
    }

    [Fact]
    public async Task UnbackedAccount_HasFloatEqualToBalance()
    {
        await using var db = NewContext();
        db.Accounts.Add(new Account { OwnerId = "user-1", Name = "Cash", Type = AccountType.Cash, Currency = CurrencyCode.Eur, OpeningBalance = 50m });
        db.SaveChanges();

        var result = await new GetAccountReconciliationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None);

        var recon = result.Single();
        recon.BackedJarCount.Should().Be(0);
        recon.Float.Should().Be(50m);
    }
}
