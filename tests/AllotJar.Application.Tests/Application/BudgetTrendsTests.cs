using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Queries.GetBudgetTrends;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The reports trend rollup: one income / planned / spent point per recent month,
/// chronological, owner-scoped, capped to the requested window.
/// </summary>
public class BudgetTrendsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-trends-{Guid.NewGuid()}")
            .Options);

    /// <summary>A month with a 1000 income line and an 800 Rent line spending `spent`
    /// (recorded as an assigned expense transaction).</summary>
    private static BudgetMonth SeedMonth(
        ApplicationDbContext db, string ownerId, int year, int month, decimal spent)
    {
        var m = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } },
                },
                new()
                {
                    Name = "Housing", Kind = CategoryKind.Expense,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Rent", PlannedAmount = 800m },
                    },
                },
            },
        };
        db.BudgetMonths.Add(m);
        db.SaveChanges();

        if (spent != 0m)
        {
            var rent = m.Categories.Single(c => c.Kind == CategoryKind.Expense).Items.Single();
            db.Transactions.Add(new Transaction
            {
                OwnerId = ownerId, BudgetItemId = rent.Id, Amount = spent, Type = TransactionType.Expense,
            });
            db.SaveChanges();
        }

        return m;
    }

    [Fact]
    public async Task Trends_ReturnsAChronologicalPointPerMonth()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 5, spent: 750m);
        SeedMonth(db, "user-1", 2026, 6, spent: 800m);

        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

        dto.Points.Should().HaveCount(2);
        dto.Points[0].Key.Should().Be("2026-05"); // oldest first
        dto.Points[1].Key.Should().Be("2026-06");

        dto.Points[0].Income.Should().Be(1000m);
        dto.Points[0].Planned.Should().Be(800m);
        dto.Points[0].Spent.Should().Be(750m);
        dto.Points[1].Spent.Should().Be(800m);

        dto.TotalIncome.Should().Be(2000m);
        dto.TotalSpent.Should().Be(1550m);
    }

    [Fact]
    public async Task Trends_RollUpReceivedIncome_SeparatelyFromBudgetedIncome()
    {
        await using var db = NewContext();
        var june = SeedMonth(db, "user-1", 2026, 6, spent: 0m);
        var salary = june.Categories.Single(c => c.Kind == CategoryKind.Income).Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", BudgetItemId = salary.Id, Amount = 950m, Type = TransactionType.Income,
        });
        await db.SaveChangesAsync();

        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

        var point = dto.Points.Single();
        point.Income.Should().Be(1000m);          // budgeted
        point.IncomeReceived.Should().Be(950m);   // actually received
        dto.TotalIncome.Should().Be(1000m);
        dto.TotalIncomeReceived.Should().Be(950m);
    }

    [Fact]
    public async Task Trends_RollsUpTrackedTransactionSpending()
    {
        await using var db = NewContext();
        var june = SeedMonth(db, "user-1", 2026, 6, spent: 0m);
        var rent = june.Categories.Single(c => c.Kind == CategoryKind.Expense).Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 820m, Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

        dto.Points.Single().Spent.Should().Be(820m);
    }

    [Fact]
    public async Task Trends_CapsToTheRequestedWindow_MostRecentMonths()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 4, spent: 100m);
        SeedMonth(db, "user-1", 2026, 5, spent: 200m);
        SeedMonth(db, "user-1", 2026, 6, spent: 300m);

        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(2), CancellationToken.None);

        dto.Points.Should().HaveCount(2);
        dto.Points.Select(p => p.Key).Should().Equal("2026-05", "2026-06"); // newest two, chronological
    }

    [Fact]
    public async Task Trends_AreOwnerScoped()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 6, spent: 800m);
        SeedMonth(db, "user-2", 2026, 6, spent: 999m);

        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

        dto.Points.Should().ContainSingle();
        dto.TotalSpent.Should().Be(800m);
    }

    [Fact]
    public async Task Trends_AreEmpty_WhenTheUserHasNoBudgets()
    {
        await using var db = NewContext();
        var handler = new GetBudgetTrendsQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

        dto.Points.Should().BeEmpty();
        dto.TotalIncome.Should().Be(0m);
        dto.TotalSpent.Should().Be(0m);
    }
}
