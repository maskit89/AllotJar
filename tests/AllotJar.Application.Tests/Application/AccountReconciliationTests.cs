using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Per-account reconciliation: an account's derived balance vs the sinking funds it
/// backs (those naming it as their funding account) read from the actual ledger, and the
/// resulting float (the account's unallocated money).
/// </summary>
public class AccountReconciliationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    [Fact]
    public async Task Reconciles_AccountBalance_AgainstBackedJarBalances()
    {
        await using var db = NewContext();

        var account = new Account
        {
            OwnerId = "user-1", Name = "Savings Joint", Type = AccountType.Savings,
            Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        db.SaveChanges();

        // The account holds 1000. A jar it backs was allocated 200 of it; its June line plans a
        // further 100, which is not money (rule 1).
        var fundId = Guid.NewGuid();
        db.Jars.Add(new Jar
        {
            Id = fundId, OwnerId = "user-1", Name = "Holiday", TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        });
        db.SaveChanges();
        LedgerFixtures.Allocate(db, "user-1", account.Id, fundId, 200m);
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
        recon.BackedJarsTotal.Should().Be(200m); // the allocation only; the planned 100 never counts
        recon.BackedJarCount.Should().Be(1);
        recon.Float.Should().Be(800m); // unallocated: 1000 − 200
        recon.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task UnbackedAccount_HasFloatEqualToBalance()
    {
        await using var db = NewContext();
        db.Accounts.Add(new Account { OwnerId = "user-1", Name = "Cash", Type = AccountType.Cash, Currency = CurrencyCode.Eur, OpeningBalance = 50m, OpeningDate = new DateOnly(2026, 1, 1) });
        db.SaveChanges();

        var result = await new GetAccountReconciliationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None);

        var recon = result.Single();
        recon.BackedJarCount.Should().Be(0);
        recon.Float.Should().Be(50m);
    }
}
