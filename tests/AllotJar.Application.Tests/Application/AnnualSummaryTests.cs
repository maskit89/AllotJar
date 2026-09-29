using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Reports.Queries.GetAnnualSummary;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The annual overview: 12 month entries for a year, owner-scoped, with year totals
/// and gaps for months that have no budget.
/// </summary>
public class AnnualSummaryTests
{
    /// <summary>A month with a 1000 income line and an 800 Rent line spending `spent`
    /// (recorded as an assigned expense transaction).</summary>
    private static void SeedMonth(ApplicationDbContext db, string ownerId, int year, int month, decimal spent)
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
    }

    [Fact]
    public async Task Annual_ReturnsTwelveMonths_WithBudgetsFilledAndGapsEmpty()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 5, spent: 750m);
        SeedMonth(db, "user-1", 2026, 6, spent: 800m);

        var handler = new GetAnnualSummaryQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetAnnualSummaryQuery(2026), CancellationToken.None);

        dto.Year.Should().Be(2026);
        dto.Months.Should().HaveCount(12);
        dto.Months.Select(m => m.Month).Should().Equal(Enumerable.Range(1, 12));

        var may = dto.Months.Single(m => m.Month == 5);
        may.HasBudget.Should().BeTrue();
        may.Income.Should().Be(1000m);
        may.Planned.Should().Be(800m);
        may.Spent.Should().Be(750m);

        var january = dto.Months.Single(m => m.Month == 1);
        january.HasBudget.Should().BeFalse();
        january.Income.Should().Be(0m);
        january.Spent.Should().Be(0m);

        dto.TotalIncome.Should().Be(2000m);
        dto.TotalPlanned.Should().Be(1600m);
        dto.TotalSpent.Should().Be(1550m); // 750 + 800
    }

    [Fact]
    public async Task Annual_IsScopedToTheYearAndTheOwner()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 6, spent: 800m);
        SeedMonth(db, "user-1", 2025, 6, spent: 500m); // different year
        SeedMonth(db, "user-2", 2026, 6, spent: 999m); // different owner

        var handler = new GetAnnualSummaryQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetAnnualSummaryQuery(2026), CancellationToken.None);

        dto.Months.Count(m => m.HasBudget).Should().Be(1);
        dto.TotalSpent.Should().Be(800m);
    }
}
