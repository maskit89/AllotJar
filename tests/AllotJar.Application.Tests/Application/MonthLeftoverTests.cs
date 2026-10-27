using FluentAssertions;
using AllotJar.Application.Budgets;
using AllotJar.Application.Budgets.Queries.GetMonthWrapUp;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// What a month leaves over for the next one, in actual money (<see cref="MonthLeftover"/>):
/// income received, less what was spent from the month's own money (a bill a jar paid was saved for
/// earlier), less what went into jars (never the money set aside when a jar was made), and what the
/// months before carried in.
/// </summary>
public class MonthLeftoverTests
{
    private const string Owner = "user-1";
    private static readonly DateOnly September = new(2026, 9, 1);

    private sealed record Lines(Guid Salary, Guid Food, Guid Holiday);

    private static Lines SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar)
    {
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = 3000m };
        var food = new BudgetItem { Name = "Food", PlannedAmount = 2800m };
        var holiday = new BudgetItem { Name = jar.Name, PlannedAmount = 200m, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { salary } },
                new() { Name = "Living", Kind = CategoryKind.Expense, DisplayOrder = 0, Items = new List<BudgetItem> { food } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { holiday } },
            },
        });
        db.SaveChanges();
        return new Lines(salary.Id, food.Id, holiday.Id);
    }

    /// <summary>
    /// September: 300 set aside into Holiday when it was made, 3,000 in, 2,500 spent on food, 200
    /// moved into the jar and a 50 bill paid from it. October: 3,000 in, 3,100 on food and 20 on no line.
    /// </summary>
    private static async Task<ApplicationDbContext> SeedAsync()
    {
        var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", opening: 500m, openingDate: September, type: AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 1000m, openingDate: September, order: 1);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 2000m, TargetDate = new DateOnly(2027, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = savings.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 300m, September);

        var sep = SeedMonth(db, September, jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 25), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 2500m, new DateOnly(2026, 9, 12), sep.Food);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m, new DateOnly(2026, 9, 26), JarAllocationKind.Reallocation);
        LedgerFixtures.Expense(db, Owner, savings.Id, 50m, new DateOnly(2026, 9, 28), sep.Holiday);

        var oct = SeedMonth(db, September.AddMonths(1), jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 10, 25), oct.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 3100m, new DateOnly(2026, 10, 12), oct.Food);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 20m, new DateOnly(2026, 10, 14));
        return db;
    }

    [Fact]
    public async Task AMonth_LeavesWhatCameInLessWhatWasSpentAndPutInJars()
    {
        await using var db = await SeedAsync();

        var september = await MonthLeftover.BetweenAsync(db, Owner, (2026, 9), (2026, 9), CancellationToken.None);

        september.Received.Should().Be(3000m);
        september.Spent.Should().Be(2500m, "the 50 bill the jar paid was saved for, not spent from September's money");
        september.IntoJars.Should().Be(200m, "the 300 set aside when the jar was made was already saved");
        september.LeftOver.Should().Be(300m);
    }

    [Fact]
    public async Task AnOverspentMonth_LeavesLessThanNothing_AndUncategorisedSpendingCounts()
    {
        await using var db = await SeedAsync();

        var october = await MonthLeftover.BetweenAsync(db, Owner, (2026, 10), (2026, 10), CancellationToken.None);

        october.Spent.Should().Be(3120m);
        october.IntoJars.Should().Be(0m);
        october.LeftOver.Should().Be(-120m);
    }

    [Fact]
    public async Task WhatEachMonthLeavesAddsUp_FromTheFirstBudget()
    {
        await using var db = await SeedAsync();

        (await MonthLeftover.CarriedIntoAsync(db, Owner, 2026, 9, CancellationToken.None)).Should().Be(0m, "the first budget has nothing before it");
        (await MonthLeftover.CarriedIntoAsync(db, Owner, 2026, 10, CancellationToken.None)).Should().Be(300m);
        (await MonthLeftover.CarriedIntoAsync(db, Owner, 2026, 11, CancellationToken.None)).Should().Be(180m, "300 left in September, 120 overspent in October");
        // A month with no budget still moves money: December has none, and January carries what it left (nothing).
        (await MonthLeftover.CarriedIntoAsync(db, Owner, 2027, 1, CancellationToken.None)).Should().Be(180m);
    }

    [Fact]
    public async Task TheWrapUp_CountsWhatEarlierMonthsCarriedIn()
    {
        await using var db = await SeedAsync();

        var wrapUp = await new GetMonthWrapUpQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMonthWrapUpQuery(2026, 10), CancellationToken.None);

        wrapUp.CarriedIn.Should().Be(300m);
        wrapUp.Received.Should().Be(3000m);
        wrapUp.Spent.Should().Be(3120m);
        wrapUp.IntoJars.Should().Be(0m);
        wrapUp.LeftOver.Should().Be(180m);
        wrapUp.IsOver.Should().Be(new DateOnly(2026, 11, 1) <= DateOnly.FromDateTime(DateTime.UtcNow));
    }

    [Fact]
    public async Task AMonthBeforeTheFirstBudget_PassesNothingOn()
    {
        await using var db = await SeedAsync();

        var august = await new GetMonthWrapUpQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMonthWrapUpQuery(2026, 8), CancellationToken.None);

        august.CarriedIn.Should().Be(0m);
        august.LeftOver.Should().Be(0m);
    }

    [Fact]
    public async Task AHouseholdWithNoBudget_CarriesNothing()
    {
        await using var db = NewContext();

        (await MonthLeftover.CarriedIntoAsync(db, Owner, 2026, 10, CancellationToken.None)).Should().Be(0m);
    }
}
