using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The one-off repair for accounts registered before PR #142, whose starter "Savings" group
/// defaulted to <see cref="CategoryKind.Expense"/> with an unlinked "Emergency Fund" line. It
/// converts the untouched starter shape into a real, jar-backed savings envelope, is conservative
/// (whole-household all-or-nothing; skips anything the user has customised), and is idempotent.
/// </summary>
public class StarterSavingsKindSeederTests
{
    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    /// <summary>Adds a month with a "Savings" group holding the given lines; returns the group.</summary>
    private static BudgetCategory AddMonthWithSavings(
        ApplicationDbContext db, string ownerId, int year, int month,
        CategoryKind kind, params BudgetItem[] items)
    {
        var savings = new BudgetCategory
        {
            Name = "Savings",
            Kind = kind,
            DisplayOrder = 3,
            Items = items.ToList(),
        };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
                savings,
            },
        });
        return savings;
    }

    /// <summary>The exact pre-#142 starter Emergency Fund line: unlinked, non-bill, Expense-defaulted.</summary>
    private static BudgetItem PristineEmergencyFund(decimal planned = 250m) =>
        new() { Name = "Emergency Fund", PlannedAmount = planned, DisplayOrder = 0 };

    [Fact]
    public async Task Converts_a_pristine_starter_savings_group_into_a_jar_backed_envelope()
    {
        using var db = NewContext();
        var group = AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund());
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        var savings = await db.BudgetCategories.AsNoTracking().SingleAsync(c => c.Id == group.Id);
        savings.Kind.Should().Be(CategoryKind.Savings);

        var jar = await db.Jars.AsNoTracking().SingleAsync();
        jar.OwnerId.Should().Be("user-1");
        jar.Name.Should().Be("Emergency Fund");
        jar.Kind.Should().Be(JarKind.Goal); // ForSavingsLine default — user shapes it later

        var line = await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Emergency Fund");
        line.SavingsId.Should().Be(jar.Id);
    }

    [Fact]
    public async Task Shares_one_jar_across_every_month_of_the_same_household()
    {
        using var db = NewContext();
        // A user who registered pre-fix and rolled the budget into three months — the buggy
        // Expense "Savings" group with its Emergency Fund line was copied into each.
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund());
        AddMonthWithSavings(db, "user-1", 2026, 7, CategoryKind.Expense, PristineEmergencyFund());
        AddMonthWithSavings(db, "user-1", 2026, 8, CategoryKind.Expense, PristineEmergencyFund());
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        // Exactly one jar for the household, and all three months' lines point at it (stable
        // SavingsId ⇒ the balance rolls over across months).
        var jar = await db.Jars.AsNoTracking().SingleAsync();
        var lines = await db.BudgetItems.AsNoTracking().Where(i => i.Name == "Emergency Fund").ToListAsync();
        lines.Should().HaveCount(3);
        lines.Should().OnlyContain(l => l.SavingsId == jar.Id);
        (await db.BudgetCategories.AsNoTracking().CountAsync(c => c.Kind == CategoryKind.Savings))
            .Should().Be(3);
    }

    [Fact]
    public async Task Preserves_an_edited_planned_amount_when_converting()
    {
        using var db = NewContext();
        // Editing the contribution is normal use, not customisation of the line's identity.
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund(planned: 300m));
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        var line = await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Emergency Fund");
        line.SavingsId.Should().NotBeNull();
        line.PlannedAmount.Should().Be(300m);
    }

    [Fact]
    public async Task Is_idempotent_a_second_run_changes_nothing()
    {
        using var db = NewContext();
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund());
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);
        await StarterSavingsKindSeeder.BackfillAsync(db); // must add no second jar / re-touch nothing

        (await db.Jars.AsNoTracking().CountAsync()).Should().Be(1);
        var jarId = (await db.Jars.AsNoTracking().SingleAsync()).Id;
        (await db.BudgetItems.AsNoTracking().Where(i => i.Name == "Emergency Fund").ToListAsync())
            .Should().OnlyContain(l => l.SavingsId == jarId);
    }

    [Fact]
    public async Task Skips_a_household_that_expanded_the_starter_savings_group()
    {
        using var db = NewContext();
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense,
            PristineEmergencyFund(),
            new BudgetItem { Name = "Car Fund", PlannedAmount = 100m, DisplayOrder = 1 });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        db.Jars.Should().BeEmpty();
        (await db.BudgetCategories.AsNoTracking().SingleAsync(c => c.Name == "Savings"))
            .Kind.Should().Be(CategoryKind.Expense); // untouched
    }

    [Fact]
    public async Task Skips_a_household_that_renamed_the_starter_line()
    {
        using var db = NewContext();
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense,
            new BudgetItem { Name = "Rainy Day", PlannedAmount = 250m, DisplayOrder = 0 });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        db.Jars.Should().BeEmpty();
        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Rainy Day"))
            .SavingsId.Should().BeNull();
    }

    [Fact]
    public async Task Skips_a_household_that_turned_the_line_into_a_bill()
    {
        using var db = NewContext();
        var ef = PristineEmergencyFund();
        ef.DueDay = 15; // deliberate customisation
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, ef);
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        db.Jars.Should().BeEmpty();
        (await db.BudgetItems.AsNoTracking().SingleAsync()).SavingsId.Should().BeNull();
    }

    [Fact]
    public async Task Skips_the_whole_household_when_any_month_deviates()
    {
        using var db = NewContext();
        // June is pristine, but July's group was expanded — be conservative, skip the household.
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund());
        AddMonthWithSavings(db, "user-1", 2026, 7, CategoryKind.Expense,
            PristineEmergencyFund(),
            new BudgetItem { Name = "Holiday", PlannedAmount = 80m, DisplayOrder = 1 });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        db.Jars.Should().BeEmpty();
        (await db.BudgetCategories.AsNoTracking().Where(c => c.Name == "Savings").ToListAsync())
            .Should().OnlyContain(c => c.Kind == CategoryKind.Expense);
    }

    [Fact]
    public async Task Skips_a_household_that_already_has_an_emergency_fund_jar()
    {
        using var db = NewContext();
        // e.g. they created a jar (which spun up a real Kind=Savings group) alongside the buggy one.
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund());
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Emergency Fund", TargetAmount = 1000m });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        (await db.Jars.AsNoTracking().CountAsync()).Should().Be(1); // no second jar minted
        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Emergency Fund"))
            .SavingsId.Should().BeNull(); // buggy group left as-is
    }

    [Fact]
    public async Task Leaves_a_correctly_seeded_post_fix_household_untouched()
    {
        using var db = NewContext();
        // What BudgetSeeder produces post-#142: Kind=Savings group + linked Emergency Fund + its jar.
        var jar = new Jar { OwnerId = "user-1", Name = "Emergency Fund", Kind = JarKind.Goal };
        db.Jars.Add(jar);
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Savings,
            new BudgetItem { Name = "Emergency Fund", PlannedAmount = 250m, DisplayOrder = 0, SavingsId = jar.Id });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        (await db.Jars.AsNoTracking().CountAsync()).Should().Be(1);
        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Emergency Fund"))
            .SavingsId.Should().Be(jar.Id);
    }

    [Fact]
    public async Task Repairs_only_the_qualifying_household_and_leaves_others_alone()
    {
        using var db = NewContext();
        AddMonthWithSavings(db, "user-1", 2026, 6, CategoryKind.Expense, PristineEmergencyFund()); // repair
        AddMonthWithSavings(db, "user-2", 2026, 6, CategoryKind.Expense,                            // skip
            PristineEmergencyFund(),
            new BudgetItem { Name = "New Car", PlannedAmount = 150m, DisplayOrder = 1 });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        var jars = await db.Jars.AsNoTracking().ToListAsync();
        jars.Should().ContainSingle().Which.OwnerId.Should().Be("user-1");

        var user2Savings = await db.BudgetCategories.AsNoTracking()
            .SingleAsync(c => c.Name == "Savings" && c.BudgetMonth.OwnerId == "user-2");
        user2Savings.Kind.Should().Be(CategoryKind.Expense);
    }

    [Fact]
    public async Task Does_nothing_when_there_are_no_savings_groups()
    {
        using var db = NewContext();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
            },
        });
        await db.SaveChangesAsync();

        await StarterSavingsKindSeeder.BackfillAsync(db);

        db.Jars.Should().BeEmpty();
    }
}
