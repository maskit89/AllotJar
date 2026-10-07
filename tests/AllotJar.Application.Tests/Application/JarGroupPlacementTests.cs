using FluentAssertions;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Jar setup plan, PR 4 (Christopher accepted it on 6 October 2026): "Add jar" inside a Dashboard
/// Savings group lands the new jar's line in that group, and in the other months in the Savings
/// group of the same name. Without a group, or with one that isn't this household's Savings group,
/// the line goes in the first Savings group, as before.
/// </summary>
public class JarGroupPlacementTests
{
    private static readonly DateOnly ThisMonth = new(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1);

    /// <summary>A month with an Income group and the given Savings groups, in that display order.</summary>
    private static BudgetMonth SeedMonth(ApplicationDbContext db, string ownerId, DateOnly month, params string[] savingsGroups)
    {
        var budget = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = month.Year,
            Month = month.Month,
            Categories = new List<BudgetCategory> { new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 } },
        };
        for (var i = 0; i < savingsGroups.Length; i++)
        {
            budget.Categories.Add(new BudgetCategory { Name = savingsGroups[i], Kind = CategoryKind.Savings, DisplayOrder = i });
        }
        db.BudgetMonths.Add(budget);
        db.SaveChanges();
        return budget;
    }

    private static BudgetCategory Group(BudgetMonth month, string name, int nth = 0) =>
        month.Categories.Where(c => c.Kind == CategoryKind.Savings && c.Name == name).OrderBy(c => c.DisplayOrder).ElementAt(nth);

    /// <summary>A 1,200 goal due a year out, added from <paramref name="groupId"/>; returns the name of each month's group holding its line.</summary>
    private static async Task<List<string>> AddJarFrom(ApplicationDbContext db, Guid? groupId, string ownerId = "user-1")
    {
        var account = LedgerFixtures.SeedAccount(db, ownerId);
        var dto = await new CreateJarCommandHandler(db, new CurrentUserStub(ownerId)).Handle(
            new CreateJarCommand("Summer holiday", JarKind.Goal, 1200m, ThisMonth.AddMonths(12),
                AccrualMethod.TargetByDate, account.Id, SavingsCategoryId: groupId),
            CancellationToken.None);
        return db.BudgetItems.Where(i => i.SavingsId == dto.Id)
            .Join(db.BudgetCategories, i => i.BudgetCategoryId, c => c.Id, (i, c) => new { c.Name, c.BudgetMonthId })
            .Join(db.BudgetMonths, x => x.BudgetMonthId, m => m.Id, (x, m) => new { x.Name, m.Year, m.Month })
            .AsEnumerable()
            .OrderBy(x => x.Year).ThenBy(x => x.Month)
            .Select(x => x.Name)
            .ToList();
    }

    [Fact]
    public async Task AddedFromAGroup_TheLineLandsInThatGroup_ThisMonthAndLater()
    {
        await using var db = NewContext();
        var october = SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");
        SeedMonth(db, "user-1", ThisMonth.AddMonths(1), "Savings", "Holidays");

        (await AddJarFrom(db, Group(october, "Holidays").Id)).Should().Equal("Holidays", "Holidays");
    }

    [Fact]
    public async Task WithoutAGroup_TheLineLandsInTheFirstSavingsGroup_AsBefore()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");

        (await AddJarFrom(db, null)).Should().Equal("Savings");
    }

    [Fact]
    public async Task AMonthWithoutAGroupOfThatName_FallsBackToItsFirstSavingsGroup()
    {
        await using var db = NewContext();
        var october = SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");
        SeedMonth(db, "user-1", ThisMonth.AddMonths(1), "Savings", "Trips");

        (await AddJarFrom(db, Group(october, "Holidays").Id)).Should().Equal("Holidays", "Savings");
    }

    [Fact]
    public async Task OtherMonthsMatchTheName_IgnoringCaseAndSpaces()
    {
        await using var db = NewContext();
        var october = SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");
        SeedMonth(db, "user-1", ThisMonth.AddMonths(1), "Savings", " holidays ");

        (await AddJarFrom(db, Group(october, "Holidays").Id)).Should().Equal("Holidays", " holidays ");
    }

    [Fact]
    public async Task TwoGroupsWithTheSameName_TheOneClickedGetsTheLine()
    {
        await using var db = NewContext();
        var october = SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays", "Holidays");
        var clicked = Group(october, "Holidays", nth: 1);

        await AddJarFrom(db, clicked.Id);

        db.BudgetItems.Single(i => i.SavingsId != null).BudgetCategoryId.Should().Be(clicked.Id);
    }

    [Fact]
    public async Task AGroupInAPastMonth_PlacesTheLineByItsNameFromThisMonthOn()
    {
        // The Dashboard can show a past month; the jar is planned from this month on (rule 46).
        await using var db = NewContext();
        var september = SeedMonth(db, "user-1", ThisMonth.AddMonths(-1), "Savings", "Holidays");
        SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");

        (await AddJarFrom(db, Group(september, "Holidays").Id)).Should().Equal("Holidays");
        Group(september, "Holidays").Items.Should().BeEmpty();
    }

    [Fact]
    public async Task AnExpenseGroup_AnUnknownGroup_OrAnotherHouseholdsGroup_IsIgnored()
    {
        await using var db = NewContext();
        var october = SeedMonth(db, "user-1", ThisMonth, "Savings", "Holidays");
        var groceries = new BudgetCategory { BudgetMonthId = october.Id, Name = "Holidays", Kind = CategoryKind.Expense, DisplayOrder = 0 };
        db.BudgetCategories.Add(groceries);
        var theirs = SeedMonth(db, "user-2", ThisMonth, "Savings", "Holidays");
        db.SaveChanges();

        // An expense group named like a Savings group still isn't one.
        (await AddJarFrom(db, groceries.Id)).Should().Equal("Savings");
        // Another household's group: its name is never read, nothing is refused.
        (await AddJarFrom(db, Group(theirs, "Holidays").Id)).Should().Equal("Savings");
        // A group deleted since the Dashboard loaded.
        (await AddJarFrom(db, Guid.NewGuid())).Should().Equal("Savings");
        db.BudgetItems.Where(i => i.SavingsId != null).Select(i => i.BudgetCategoryId).Distinct()
            .Should().Equal(Group(october, "Savings").Id);
    }
}
