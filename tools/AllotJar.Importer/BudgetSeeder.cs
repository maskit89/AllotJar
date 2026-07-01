using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Importer;

/// <summary>
/// Phase 2a — the budget scaffolding. Creates the 12 (identical-planned) 2026 budget
/// months that mirror the spreadsheet's monthly plan, building the entities directly so
/// fund lines can carry the right <see cref="BudgetItem.SavingsId"/> (= the Jar id,
/// which the high-level AddBudgetItem command cannot set). Planned amounts come straight
/// from the sheet so the budget reconciles exactly. Per month:
///   Income            — a salary line per member (net monthly income);
///   Living Costs      — the 12 living-cost envelopes;
///   Pocket Money      — €250 per member;
///   Personal Savings  — the allocation-waterfall surplus per member;
///   Yearly Funds      — 26 fund lines (proportional-pool contribution);
///   Monthly Commitments — 15 fund lines (straight-line contribution).
/// </summary>
internal static class BudgetSeeder
{
    private const int Year = 2026;

    public static async Task<int> RunAsync(
        string conn, string email, ReferenceData reference, BudgetSheetData budget, bool commit)
    {
        await using var provider = ImporterHost.Build(conn);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var currentUser = provider.GetRequiredService<ImporterCurrentUser>();

        var normalized = email.ToUpperInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);
        if (user is null)
        {
            Console.Error.WriteLine($"Owner '{email}' not found — run reference `import` first.");
            return 1;
        }
        var owner = user.Id;
        currentUser.UserId = owner;

        // Fund lines link to the Jars created in the reference phase, matched by name.
        var fundIdByName = await db.Jars.AsNoTracking()
            .Where(f => f.OwnerId == owner)
            .ToDictionaryAsync(f => f.Name, f => f.Id, StringComparer.OrdinalIgnoreCase);

        if (fundIdByName.Count == 0)
        {
            Console.Error.WriteLine("No sinking funds found for the owner — run reference `import --commit` first.");
            return 1;
        }

        var plan = BuildPlan(reference, budget, fundIdByName, out var missing);
        PrintPlan(plan, missing);

        if (!commit)
        {
            Console.WriteLine();
            Console.WriteLine("DRY RUN — no budget months were written. Re-run with --commit.");
            return missing.Count == 0 ? 0 : 2;
        }
        if (missing.Count > 0)
        {
            Console.Error.WriteLine("Refusing to commit: some fund lines have no matching Jar (see above).");
            return 2;
        }

        // Idempotent: clear this owner's months (cascades categories + items) and rebuild.
        await db.BudgetItems.Where(i => i.BudgetCategory.BudgetMonth.OwnerId == owner).ExecuteDeleteAsync();
        await db.BudgetCategories.Where(c => c.BudgetMonth.OwnerId == owner).ExecuteDeleteAsync();
        var removed = await db.BudgetMonths.Where(m => m.OwnerId == owner).ExecuteDeleteAsync();
        if (removed > 0) Console.WriteLine($"  Cleared {removed} existing budget months.");

        for (int month = 1; month <= 12; month++)
        {
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = owner,
                Year = Year,
                Month = month,
                BaseCurrency = CurrencyCode.Eur,
                Categories = plan.Select((cat, ci) => new BudgetCategory
                {
                    Name = cat.Name,
                    Kind = cat.Kind,
                    ExcludeFromAllocation = cat.ExcludeFromAllocation,
                    DisplayOrder = ci,
                    Items = cat.Lines.Select((line, li) => new BudgetItem
                    {
                        Name = line.Name,
                        PlannedAmount = line.Planned,
                        DisplayOrder = li,
                        SavingsId = line.FundId,
                    }).ToList(),
                }).ToList(),
            });
        }
        await db.SaveChangesAsync();
        Console.WriteLine($"  Created 12 budget months ({plan.Sum(c => c.Lines.Count)} lines each).");

        return await VerifyAsync(db, owner, plan) ? 0 : 2;
    }

    // --- Plan construction --------------------------------------------------
    private static IReadOnlyList<CategoryPlan> BuildPlan(
        ReferenceData reference, BudgetSheetData budget,
        IReadOnlyDictionary<string, Guid> fundIdByName, out List<string> missing)
    {
        missing = new List<string>();
        var members = reference.Members;

        var income = new CategoryPlan("Income", CategoryKind.Income,
            members.Select(m => new LinePlan($"{m.Name} — Salary", m.NetMonthlyIncome, null)).ToList());

        var living = new CategoryPlan("Living Costs", CategoryKind.Expense,
            budget.LivingLines.Select(l => new LinePlan(l.Name, l.Monthly, null)).ToList());

        var pocket = new CategoryPlan("Pocket Money", CategoryKind.Expense,
            members.Select(m => new LinePlan(m.Name, budget.PocketPerMember, null)).ToList());

        // Personal Savings is the allocation engine's *output* (the surplus), not a shared cost,
        // so it's flagged out of the allocation obligations to avoid double-counting the surplus.
        var savings = new CategoryPlan("Personal Savings", CategoryKind.Expense,
            members.Select(m => new LinePlan(m.Name, budget.SurplusByMember.GetValueOrDefault(m.Name), null)).ToList(),
            ExcludeFromAllocation: true);

        var yearly = FundCategory("Yearly Funds", reference, AccrualMethod.ProportionalPool, fundIdByName, missing);
        var monthly = FundCategory("Monthly Commitments", reference, AccrualMethod.StraightLine, fundIdByName, missing);

        return new[] { income, living, pocket, savings, yearly, monthly };
    }

    private static CategoryPlan FundCategory(
        string name, ReferenceData reference, AccrualMethod accrual,
        IReadOnlyDictionary<string, Guid> fundIdByName, List<string> missing)
    {
        var lines = new List<LinePlan>();
        foreach (var f in reference.Funds.Where(f => f.Accrual == accrual))
        {
            if (!fundIdByName.TryGetValue(f.Name, out var id))
            {
                missing.Add(f.Name);
                continue;
            }
            lines.Add(new LinePlan(f.Name, f.MonthlyContribution, id));
        }
        return new CategoryPlan(name, CategoryKind.Savings, lines);
    }

    // --- Output / verification ---------------------------------------------
    private static void PrintPlan(IReadOnlyList<CategoryPlan> plan, List<string> missing)
    {
        Console.WriteLine();
        Console.WriteLine("BUDGET PLAN (per month, identical across all 12 months)");
        foreach (var cat in plan)
        {
            Console.WriteLine($"  {cat.Name,-22} {cat.Kind,-8} {cat.Lines.Count,3} lines  Σ {cat.Lines.Sum(l => l.Planned),12:#,##0.00}");
        }
        var income = plan.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.Lines.Sum(l => l.Planned));
        var outflow = plan.Where(c => c.Kind != CategoryKind.Income).Sum(c => c.Lines.Sum(l => l.Planned));
        Console.WriteLine($"  {"TOTAL income",-22} {income,25:#,##0.00}");
        Console.WriteLine($"  {"TOTAL planned outflow",-22} {outflow,25:#,##0.00}");
        Console.WriteLine($"  {"Remaining to budget",-22} {income - outflow,25:#,##0.00}");
        if (missing.Count > 0)
            Console.WriteLine($"  !! {missing.Count} fund line(s) without a matching Jar: {string.Join(", ", missing)}");
    }

    private static async Task<bool> VerifyAsync(ApplicationDbContext db, string owner, IReadOnlyList<CategoryPlan> plan)
    {
        var months = await db.BudgetMonths.AsNoTracking()
            .Where(m => m.OwnerId == owner)
            .Include(m => m.Categories).ThenInclude(c => c.Items)
            .ToListAsync();

        var perMonthIncome = plan.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.Lines.Sum(l => l.Planned));
        var perMonthOutflow = plan.Where(c => c.Kind != CategoryKind.Income).Sum(c => c.Lines.Sum(l => l.Planned));

        Console.WriteLine();
        Console.WriteLine("VERIFY (database read-back)");
        var ok = true;
        ok &= Row("Budget months", months.Count, 12);
        var dbIncome = months.Sum(m => m.Categories.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.Items.Sum(i => i.PlannedAmount)));
        var dbOutflow = months.Sum(m => m.Categories.Where(c => c.Kind != CategoryKind.Income).Sum(c => c.Items.Sum(i => i.PlannedAmount)));
        ok &= Money("Σ planned income (×12)", dbIncome, perMonthIncome * 12);
        ok &= Money("Σ planned outflow (×12)", dbOutflow, perMonthOutflow * 12);
        var fundLines = months.Sum(m => m.Categories.Where(c => c.Kind == CategoryKind.Savings).Sum(c => c.Items.Count(i => i.SavingsId != null)));
        ok &= Row("Fund lines linked (×12)", fundLines, 41 * 12);

        Console.WriteLine();
        Console.WriteLine(ok ? "BUDGET VERIFIED." : "BUDGET MISMATCH — investigate.");
        return ok;

        static bool Row(string label, int actual, int expected)
        {
            var ok = actual == expected;
            Console.WriteLine($"  {label,-26} db={actual,12}  expected={expected,12}  {(ok ? "OK" : "*** MISMATCH ***")}");
            return ok;
        }
        static bool Money(string label, decimal actual, decimal expected)
        {
            var ok = Math.Abs(actual - expected) <= 0.5m;
            Console.WriteLine($"  {label,-26} db={actual,12:#,##0.00}  expected={expected,12:#,##0.00}  {(ok ? "OK" : "*** MISMATCH ***")}");
            return ok;
        }
    }

    private sealed record CategoryPlan(string Name, CategoryKind Kind, IReadOnlyList<LinePlan> Lines, bool ExcludeFromAllocation = false);
    private sealed record LinePlan(string Name, decimal Planned, Guid? FundId);
}
