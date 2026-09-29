using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// A row in another currency that still waits for its budget-currency amount (rules 42/44) is
/// EXCLUDED from budget actuals and jar balances, and the month carries a count so the
/// incompleteness is visible. Once the user confirms its amount it counts like any other row.
/// </summary>
public class FxPendingAggregatesTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    /// <summary>June 2026 (EUR) with one expense line; returns the line.</summary>
    private static BudgetItem SeedJune(ApplicationDbContext db, string ownerId)
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries } },
            },
        });
        db.SaveChanges();
        return groceries;
    }

    private static Transaction Tx(
        string ownerId, decimal amount, Guid? lineId, bool fxPending = false, string currency = "EUR")
    {
        return new Transaction
        {
            OwnerId = ownerId,
            Date = new DateOnly(2026, 6, 10),
            Payee = "Foreign Shop",
            Amount = amount,
            Currency = CurrencyCode.From(currency),
            FxPending = fxPending,
            Type = TransactionType.Expense,
            BudgetItemId = lineId,
        };
    }

    [Fact]
    public async Task BudgetActuals_ExcludePendingRows_AndReportTheCount()
    {
        await using var db = NewContext();
        var line = SeedJune(db, "user-1");
        db.Transactions.AddRange(
            Tx("user-1", 100m, line.Id),                                  // resolved — counts
            Tx("user-1", 40m, line.Id, fxPending: true, currency: "GBP")); // pending — excluded
        await db.SaveChangesAsync();

        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        // The pending 40 (face value at placeholder rate 1) is NOT presented as base-currency money.
        month.Categories.Single().Items.Single().ActualAmount.Should().Be(100m);
        month.FxPendingCount.Should().Be(1);
    }

    [Fact]
    public async Task BudgetActuals_ExcludeSlicesOfAPendingParent()
    {
        await using var db = NewContext();
        var line = SeedJune(db, "user-1");
        var parent = Tx("user-1", 40m, lineId: null, fxPending: true, currency: "GBP");
        db.Transactions.Add(parent);
        db.SaveChanges();
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = parent.Id, BudgetItemId = line.Id, Amount = 40m });
        await db.SaveChangesAsync();

        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        month.Categories.Single().Items.Single().ActualAmount.Should().Be(0m);
        month.FxPendingCount.Should().Be(1);
    }

    [Fact]
    public async Task JarBalances_ExcludePendingSpending()
    {
        // A jar's balance is its account ledger (rule 79): the resolved EUR spend on the jar line
        // from the jar's account draws from it; the pending foreign-currency row is not an
        // account movement (it has no account leg in the account's currency) and never touches
        // the jar at its placeholder face value. The planned 200 is a plan and counts nowhere.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jarId = Guid.NewGuid();
        db.Jars.Add(new Jar { Id = jarId, OwnerId = "user-1", Name = "Holiday", TargetAmount = 500m, FundingAccountId = account.Id });
        db.SaveChanges();
        LedgerFixtures.Allocate(db, "user-1", account.Id, jarId, 200m);
        var fundLine = new BudgetItem { Name = "Holiday", PlannedAmount = 200m, SavingsId = jarId };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { fundLine } },
            },
        });
        db.SaveChanges();
        var resolved = Tx("user-1", 50m, fundLine.Id);                                  // resolved spend
        resolved.AccountId = account.Id;
        db.Transactions.AddRange(
            resolved,
            Tx("user-1", 30m, fundLine.Id, fxPending: true, currency: "GBP")); // pending — excluded
        await db.SaveChangesAsync();

        var jars = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);

        // 200 allocated − 50 real spend; the pending 30 is not subtracted at face value.
        jars.Single().CurrentBalance.Should().Be(150m);
    }

    [Fact]
    public async Task A_confirmed_amount_counts_on_its_line_and_leaves_the_waiting_count()
    {
        await using var db = NewContext();
        var line = SeedJune(db, "user-1");
        var waiting = Tx("user-1", 40m, line.Id, fxPending: true, currency: "GBP");
        db.Transactions.Add(waiting);
        await db.SaveChangesAsync();

        await new ConfirmConvertedAmountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ConfirmConvertedAmountCommand(waiting.Id, 46.80m), CancellationToken.None);

        var month = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        month.Categories.Single().Items.Single().ActualAmount.Should().Be(46.80m);
        month.FxPendingCount.Should().Be(0);
    }
}
