using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// Creates a sample budget for a brand-new user who opted in at sign-up, so the dashboard
/// has data to explore on first login. Income is seeded above the planned total on purpose,
/// leaving a positive "Remaining to Budget" for the user to assign to €0.00.
/// </summary>
public static class BudgetSeeder
{
    public static async Task SeedDefaultMonthAsync(
        ApplicationDbContext db,
        string ownerId,
        int year,
        int month,
        string? baseCurrency = null,
        CancellationToken ct = default)
    {
        // Strictly a brand-new-household seed: any existing month (not just the target one) means
        // the owner has a real budget, and sample figures must never be injected into it.
        var exists = await db.BudgetMonths.AnyAsync(m => m.OwnerId == ownerId, ct);
        if (exists)
        {
            return;
        }

        // The starter savings line is a real jar from day one — SavingsId is an
        // enforced FK to Jars.Id, and the jar is what makes the line's balance roll
        // over (and gives the Jars page something to show a brand-new user).
        var emergencyFund = SavingsLines.AddBackingJar(db, ownerId, "Emergency Fund");

        var budget = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            // The sample month adopts the registrant's home currency (same rule as
            // CreateBudgetMonth's first month) so accounts created at their preference
            // default don't trip the account-currency invariant. EUR is the last resort.
            BaseCurrency = CurrencyCode.From(
                UserPreferences.NormalizeCurrency(baseCurrency) ?? UserPreferences.DefaultCurrency),
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
