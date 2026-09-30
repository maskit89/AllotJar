using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// Validates the core zero-based-budgeting metric: RemainingToBudget == Income - Sum(Planned).
/// Income is now itself a category group (one line carrying the income), so these
/// pure domain tests also prove income lines feed TotalIncome and are never counted
/// as planned spending. No database, no mocks.
/// </summary>
public class RemainingToBudgetTests
{
    private static BudgetMonth BuildMonth(decimal income, params decimal[] plannedAmounts)
    {
        var incomeGroup = new BudgetCategory
        {
            Name = "Income",
            Kind = CategoryKind.Income,
            Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = income } }
        };

        var expenseGroup = new BudgetCategory
        {
            Name = "Test",
            Kind = CategoryKind.Expense,
            Items = plannedAmounts
                .Select((amount, i) => new BudgetItem { Name = $"Item {i}", PlannedAmount = amount })
                .ToList()
        };

        return new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory> { incomeGroup, expenseGroup }
        };
    }

    // A month is balanced only when every euro of a non-zero income has a job: an empty month
    // (remaining 0, no income) is NOT balanced, so the UI prompts for income instead.
    [Theory]
    [InlineData(3000, new[] { 1000.0, 500.0 }, 1500, false)]              // income exceeds planned
    [InlineData(2000, new[] { 1200.0, 800.0 }, 0, true)]                  // every euro assigned
    [InlineData(1000, new[] { 700.0, 600.0 }, -300, false)]               // over-budgeted
    [InlineData(2500, new double[0], 2500, false)]                        // nothing planned yet
    [InlineData(0, new[] { 100.0, 50.0 }, -150, false)]                   // no income, no throw
    [InlineData(0, new double[0], 0, false)]                              // empty month
    [InlineData(5000, new[] { 4999.99 }, 0.01, false)]
    [InlineData(0, new[] { 0.0001 }, -0.0001, false)]
    [InlineData(100, new[] { 33.3333, 33.3333, 33.3333 }, 0.0001, false)] // four decimals, no rounding
    public void RemainingToBudget_IsIncomeMinusPlanned(double income, double[] planned, double remaining, bool balanced)
    {
        var month = BuildMonth((decimal)income, planned.Select(p => (decimal)p).ToArray());

        Assert.Equal((decimal)remaining, month.RemainingToBudget);
        Assert.Equal(balanced, month.IsBalanced);
    }

    [Fact]
    public void TotalPlanned_SumsAcrossMultipleExpenseCategories_ExcludingIncome()
    {
        var month = new BudgetMonth
        {
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income",
                    Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { PlannedAmount = 1000m } }
                },
                new() { Name = "Housing", Items = new List<BudgetItem> { new() { PlannedAmount = 600m } } },
                new() { Name = "Food", Items = new List<BudgetItem> { new() { PlannedAmount = 250m } } },
            }
        };

        Assert.Equal(1000m, month.TotalIncome);
        Assert.Equal(850m, month.TotalPlanned); // income line excluded
        Assert.Equal(150m, month.RemainingToBudget);
    }
}
