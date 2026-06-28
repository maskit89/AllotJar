using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Application.Budgets.Templates;

/// <summary>A starter budget structure (groups + line names) a user can begin from.</summary>
public record BudgetTemplate(
    string Key,
    string Name,
    string Description,
    IReadOnlyList<BudgetTemplateGroup> Groups);

public record BudgetTemplateGroup(string Name, CategoryKind Kind, IReadOnlyList<string> Lines);

/// <summary>
/// The built-in quick-start templates offered when creating a budget for a month
/// with nothing to copy. Lines start at a planned amount of 0 — the structure is
/// the head start; the user assigns their own Euros.
/// </summary>
public static class BudgetTemplates
{
    public static readonly IReadOnlyList<BudgetTemplate> All = new[]
    {
        new BudgetTemplate(
            "essentials",
            "Essentials",
            "A clean starting point covering the bills most households share.",
            new[]
            {
                new BudgetTemplateGroup("Income", CategoryKind.Income, new[] { "Take-home Pay" }),
                new BudgetTemplateGroup("Housing", CategoryKind.Expense, new[] { "Rent / Mortgage", "Utilities", "Internet & Phone" }),
                new BudgetTemplateGroup("Food", CategoryKind.Expense, new[] { "Groceries", "Restaurants" }),
                new BudgetTemplateGroup("Transport", CategoryKind.Expense, new[] { "Fuel", "Public Transport", "Car Insurance" }),
                new BudgetTemplateGroup("Lifestyle", CategoryKind.Expense, new[] { "Subscriptions", "Clothing", "Personal Care" }),
                new BudgetTemplateGroup("Savings", CategoryKind.Savings, new[] { "Emergency Fund" }),
            }),
        new BudgetTemplate(
            "student",
            "Student",
            "A lightweight budget for term-time living costs.",
            new[]
            {
                new BudgetTemplateGroup("Income", CategoryKind.Income, new[] { "Part-time Job", "Student Finance" }),
                new BudgetTemplateGroup("Living", CategoryKind.Expense, new[] { "Rent", "Groceries", "Phone" }),
                new BudgetTemplateGroup("Study", CategoryKind.Expense, new[] { "Books & Supplies", "Course Fees" }),
                new BudgetTemplateGroup("Social", CategoryKind.Expense, new[] { "Eating Out", "Entertainment" }),
                new BudgetTemplateGroup("Savings", CategoryKind.Savings, new[] { "Rainy Day Fund" }),
            }),
        new BudgetTemplate(
            "family",
            "Family",
            "Two incomes, the kids, and sinking funds for the big stuff.",
            new[]
            {
                new BudgetTemplateGroup("Income", CategoryKind.Income, new[] { "Take-home Pay", "Partner's Pay" }),
                new BudgetTemplateGroup("Housing", CategoryKind.Expense, new[] { "Rent / Mortgage", "Utilities", "Internet & Phone", "Home Maintenance" }),
                new BudgetTemplateGroup("Food", CategoryKind.Expense, new[] { "Groceries", "Restaurants" }),
                new BudgetTemplateGroup("Transport", CategoryKind.Expense, new[] { "Fuel", "Public Transport", "Car Insurance" }),
                new BudgetTemplateGroup("Children", CategoryKind.Expense, new[] { "Childcare", "School", "Activities" }),
                new BudgetTemplateGroup("Lifestyle", CategoryKind.Expense, new[] { "Subscriptions", "Clothing", "Personal Care" }),
                new BudgetTemplateGroup("Savings", CategoryKind.Savings, new[] { "Emergency Fund", "Holiday", "Christmas" }),
            }),
    };

    public static BudgetTemplate? Find(string? key) =>
        string.IsNullOrWhiteSpace(key)
            ? null
            : All.FirstOrDefault(t => string.Equals(t.Key, key, StringComparison.OrdinalIgnoreCase));
}
