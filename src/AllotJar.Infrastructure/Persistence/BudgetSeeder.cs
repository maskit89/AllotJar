using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Creates a starter budget for a brand-new user so the dashboard has data to
/// render on first login. Income is seeded above the planned total on purpose,
/// leaving a positive "Remaining to Budget" for the user to assign to €0.00.
/// </summary>
public static class BudgetSeeder
{
    public static async Task SeedDefaultMonthAsync(
        ApplicationDbContext db,
        string ownerId,
        int year,
        int month,
        CancellationToken ct = default)
    {
        var exists = await db.BudgetMonths
            .AnyAsync(m => m.OwnerId == ownerId && m.Year == year && m.Month == month, ct);
        if (exists)
        {
            return;
        }

        // The starter savings line is a real jar from day one — SavingsId is an
        // enforced FK to Jars.Id, and the jar is what makes the line's balance roll
        // over (and gives the Jars page something to show a brand-new user).
        var emergencyFund = Jar.ForSavingsLine(ownerId, "Emergency Fund");
        db.Jars.Add(emergencyFund);

        var budget = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income",
                    Kind = CategoryKind.Income,
                    DisplayOrder = 0,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Take-home Pay", PlannedAmount = 3000.00m, DisplayOrder = 0 },
                    }
                },
                new()
                {
                    Name = "Housing",
                    DisplayOrder = 0,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Rent", PlannedAmount = 1100.00m, DisplayOrder = 0 },
                        new() { Name = "Utilities", PlannedAmount = 180.00m, DisplayOrder = 1 },
                    }
                },
                new()
                {
                    Name = "Transport",
                    DisplayOrder = 1,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Fuel", PlannedAmount = 120.00m, DisplayOrder = 0 },
                        new() { Name = "Public Transport", PlannedAmount = 60.00m, DisplayOrder = 1 },
                    }
                },
                new()
                {
                    Name = "Food",
                    DisplayOrder = 2,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Groceries", PlannedAmount = 400.00m, DisplayOrder = 0 },
                        new() { Name = "Dining Out", PlannedAmount = 90.00m, DisplayOrder = 1 },
                    }
                },
                new()
                {
                    Name = "Savings",
                    // Savings kind (not the Expense default): the line rolls over
                    // month-to-month and surfaces as a jar.
                    Kind = CategoryKind.Savings,
                    DisplayOrder = 0,
                    Items = new List<BudgetItem>
                    {
                        new()
                        {
                            Name = "Emergency Fund",
                            PlannedAmount = 250.00m,
                            DisplayOrder = 0,
                            SavingsId = emergencyFund.Id,
                        },
                    }
                }
            }
        };

        db.BudgetMonths.Add(budget);
        await db.SaveChangesAsync(ct);
    }
}
