using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Pending-FX honesty in the derived aggregates (2026-07-22 re-review F5): a row whose rate is
/// still the placeholder 1 must be EXCLUDED from budget actuals and jar balances, the month must
/// carry a pending count so the incompleteness is visible, and the background reconcile entry
/// point must resolve pending rows for every owner without an import.
/// </summary>
public class FxPendingAggregatesTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-fxagg-{Guid.NewGuid()}")
            .Options);

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
            ExchangeRate = 1m,
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
        await using var db = NewContext();
        var jarId = Guid.NewGuid();
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
        db.Transactions.AddRange(
            Tx("user-1", 50m, fundLine.Id),                                   // resolved spend
            Tx("user-1", 30m, fundLine.Id, fxPending: true, currency: "GBP")); // pending — excluded
        await db.SaveChangesAsync();

        var balances = await JarBalances.ComputeAsync(db, "user-1", CancellationToken.None);

        // 200 contributed − 50 real spend; the pending 30 is not subtracted at face value.
        balances[jarId].Should().Be(150m);
    }

    [Fact]
    public async Task ReconcileAllPending_ResolvesEveryOwnersRows_WithoutAnImport()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        db.Transactions.AddRange(
            Tx("user-1", 40m, lineId: null, fxPending: true, currency: "GBP"),
            Tx("user-2", 25m, lineId: null, fxPending: true, currency: "GBP"));
        await db.SaveChangesAsync();

        var reconciled = await FxRateResolver.ReconcileAllPendingAsync(
            db, new FakeExchangeRateProvider(1.15m), CancellationToken.None);

        reconciled.Should().Be(2);
        var rows = await db.Transactions.ToListAsync();
        rows.Should().OnlyContain(t => !t.FxPending);
        rows.Should().OnlyContain(t => t.ExchangeRate == 1.15m);
    }

    [Fact]
    public async Task ReconcileAllPending_LeavesRowsPending_WhenTheProviderStillFails()
    {
        await using var db = NewContext();
        db.Transactions.Add(Tx("user-1", 40m, lineId: null, fxPending: true, currency: "GBP"));
        await db.SaveChangesAsync();

        var reconciled = await FxRateResolver.ReconcileAllPendingAsync(
            db, new FakeExchangeRateProvider(rate: null), CancellationToken.None);

        reconciled.Should().Be(0);
        (await db.Transactions.SingleAsync()).FxPending.Should().BeTrue();
    }
}
