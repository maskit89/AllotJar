using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Dashboard budget-view coverage (catalog prefix DASH, file
/// docs/testing/cases/06-dashboard-budget-view.md). Focuses on the parts of the
/// dashboard that live at the Application/domain layer rather than in the client:
/// transaction-derived actuals computed at read time (kind-aware; income lines sum
/// Income transactions, expense/savings lines sum Expense transactions; split slices
/// roll up at the parent's exchange rate; transfers never roll up), the
/// TotalIncome / TotalPlanned / RemainingToBudget hero math, the PR #172
/// empty-vs-balanced rule, and planned-amount edit persistence through the
/// UpdateBudgetItem command. Pure client-render/optimistic-UI cases are deferred
/// to the Vitest layer.
///
/// The canonical "JUL26" fixture from the catalog (§ Test data setup) is rebuilt in
/// <see cref="SeedJul26"/>: Income (Take-home Pay planned 2,600 / received 2,600;
/// Freelance planned 400 / received 0) → TotalIncome 3,000; Housing (Rent 1,100,
/// Utilities 180); Food (Groceries 400 / spent 250; Restaurants 90 / spent 120);
/// Savings (Holiday planned 150) → TotalPlanned 1,920 → Remaining 1,080.
/// </summary>
public class DDashboardActualsCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-dash-actuals-{Guid.NewGuid()}")
            .Options);

    private sealed record Jul26(
        Guid MonthId,
        Guid TakeHomePayId,
        Guid FreelanceId,
        Guid RentId,
        Guid UtilitiesId,
        Guid GroceriesId,
        Guid RestaurantsId,
        Guid HolidayId);

    /// <summary>
    /// Builds the catalog's canonical JUL26 month for <paramref name="ownerId"/> plus the
    /// three transactions that drive its actuals (Take-home received 2,600; Groceries
    /// spent 250; Restaurants spent 120). Returns the ids the edit/assert cases need.
    /// </summary>
    private static Jul26 SeedJul26(ApplicationDbContext db, string ownerId = "user-1")
    {
        var takeHome = new BudgetItem { Name = "Take-home Pay", PlannedAmount = 2600m, DisplayOrder = 0 };
        var freelance = new BudgetItem { Name = "Freelance", PlannedAmount = 400m, DisplayOrder = 1 };
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 1100m, DueDay = 1, DisplayOrder = 0 };
        var utilities = new BudgetItem { Name = "Utilities", PlannedAmount = 180m, DueDay = 20, DisplayOrder = 1 };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m, DisplayOrder = 0 };
        var restaurants = new BudgetItem { Name = "Restaurants", PlannedAmount = 90m, DisplayOrder = 1 };
        var holiday = new BudgetItem { Name = "Holiday", PlannedAmount = 150m, SavingsId = Guid.NewGuid(), DisplayOrder = 0 };

        var month = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0,
                    Items = new List<BudgetItem> { takeHome, freelance },
                },
                new()
                {
                    Name = "Housing", Kind = CategoryKind.Expense, DisplayOrder = 0,
                    Items = new List<BudgetItem> { rent, utilities },
                },
                new()
                {
                    Name = "Food", Kind = CategoryKind.Expense, DisplayOrder = 1,
                    Items = new List<BudgetItem> { groceries, restaurants },
                },
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
                    Items = new List<BudgetItem> { holiday },
                },
            },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();

        db.Transactions.AddRange(
            new Transaction { OwnerId = ownerId, BudgetItemId = takeHome.Id, Amount = 2600m, Type = TransactionType.Income, Date = new DateOnly(2026, 7, 1), Payee = "Employer" },
            new Transaction { OwnerId = ownerId, BudgetItemId = groceries.Id, Amount = 250m, Type = TransactionType.Expense, Date = new DateOnly(2026, 7, 4), Payee = "Supermarket" },
            new Transaction { OwnerId = ownerId, BudgetItemId = restaurants.Id, Amount = 120m, Type = TransactionType.Expense, Date = new DateOnly(2026, 7, 6), Payee = "Cafe" });
        db.SaveChanges();

        return new Jul26(month.Id, takeHome.Id, freelance.Id, rent.Id, utilities.Id, groceries.Id, restaurants.Id, holiday.Id);
    }

    private static GetBudgetMonthQueryHandler ReadHandler(ApplicationDbContext db, string ownerId = "user-1") =>
        new(db, new CurrentUserStub(ownerId));

    private static UpdateBudgetItemCommandHandler EditHandler(ApplicationDbContext db, string ownerId = "user-1") =>
        new(db, new CurrentUserStub(ownerId));

    private static Task<BudgetMonthDto> ReadJul26(ApplicationDbContext db, string ownerId = "user-1") =>
        ReadHandler(db, ownerId).Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);

    // DASH-014 — Under-allotted month hero tiles: Income = Σ income planned (3,000),
    // Allotted = Σ non-income planned incl. savings (1,920), Remaining = 1,080, not balanced.
    [Fact]
    public async Task Jul26_HeroTiles_ComputeIncomeAllottedAndRemaining()
    {
        await using var db = NewContext();
        SeedJul26(db);

        var dto = await ReadJul26(db);

        dto.TotalIncome.Should().Be(3000m);       // Take-home 2,600 + Freelance 400
        dto.TotalPlanned.Should().Be(1920m);      // 1,280 Housing + 490 Food + 150 Savings (income excluded, savings included)
        dto.RemainingToBudget.Should().Be(1080m); // "€1,080.00 still to assign"
        dto.IsBalanced.Should().BeFalse();
    }

    // DASH-031 — Income header shows transaction-derived "received of planned": the income
    // line's ActualAmount sums Income transactions, is read-only-derived, and an unfunded
    // income line reads 0.
    [Fact]
    public async Task Jul26_IncomeLine_ReceivedIsDerivedFromIncomeTransactions()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        var dto = await ReadJul26(db);

        var income = dto.Categories.Single(c => c.Kind == "Income");
        income.TotalPlanned.Should().Be(3000m);
        income.TotalActual.Should().Be(2600m); // header: "€2,600.00 of €3,000.00"

        var takeHome = income.Items.Single(i => i.Id == ids.TakeHomePayId);
        takeHome.ActualAmount.Should().Be(2600m);
        takeHome.Remaining.Should().Be(0m);     // 2,600 received of 2,600 planned → bar at 100%

        var freelance = income.Items.Single(i => i.Id == ids.FreelanceId);
        freelance.ActualAmount.Should().Be(0m); // no income transaction → 0% bar
    }

    // DASH-031 / DASH-050 — Actuals are KIND-AWARE at read time: an income line rolls up
    // only Income transactions (an Expense tag on it is ignored) and an expense line rolls
    // up only Expense transactions (an Income tag on it is ignored). A line with no matching
    // transaction reads 0.
    [Fact]
    public async Task Actuals_AreKindAware_LinesIgnoreTheWrongTransactionType()
    {
        await using var db = NewContext();

        var pay = new BudgetItem { Name = "Pay", PlannedAmount = 1000m };
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 800m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { pay } },
                new() { Name = "Housing", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { rent } },
            },
        });
        db.SaveChanges();

        db.Transactions.AddRange(
            // Correct kinds — these count.
            new Transaction { OwnerId = "user-1", BudgetItemId = pay.Id, Amount = 900m, Type = TransactionType.Income },
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 700m, Type = TransactionType.Expense },
            // Wrong kinds tagged onto the same lines — these must be ignored.
            new Transaction { OwnerId = "user-1", BudgetItemId = pay.Id, Amount = 500m, Type = TransactionType.Expense },
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 400m, Type = TransactionType.Income });
        db.SaveChanges();

        var dto = await ReadJul26(db);

        dto.Categories.Single(c => c.Kind == "Income").Items.Single().ActualAmount.Should().Be(900m);
        dto.Categories.Single(c => c.Kind == "Expense").Items.Single().ActualAmount.Should().Be(700m);
    }

    // DASH scope (kind-aware actuals) — Transfer-type transactions NEVER roll up into a
    // line's actual, even if one is tagged to a budget line: BudgetActuals only sums the
    // line's own kind (Income/Expense), and a Transfer matches neither.
    [Fact]
    public async Task TransferTransactions_NeverRollUpIntoLineActuals()
    {
        await using var db = NewContext();

        var pay = new BudgetItem { Name = "Pay", PlannedAmount = 1000m };
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 800m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { pay } },
                new() { Name = "Housing", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { rent } },
            },
        });
        db.SaveChanges();

        db.Transactions.AddRange(
            new Transaction { OwnerId = "user-1", BudgetItemId = pay.Id, Amount = 250m, Type = TransactionType.Transfer },
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 250m, Type = TransactionType.Transfer });
        db.SaveChanges();

        var dto = await ReadJul26(db);

        dto.Categories.Single(c => c.Kind == "Income").Items.Single().ActualAmount.Should().Be(0m);
        var rentDto = dto.Categories.Single(c => c.Kind == "Expense").Items.Single();
        rentDto.ActualAmount.Should().Be(0m);
        rentDto.Remaining.Should().Be(800m); // untouched by the transfer
    }

    // DASH-050 (split slices) — A split transaction's slices roll up to each of their lines
    // at the PARENT's exchange rate; the split parent (BudgetItemId null) contributes nothing
    // itself, so there is no double counting.
    [Fact]
    public async Task SplitSlices_RollUpToEachLine_AtParentExchangeRate_NoDoubleCount()
    {
        await using var db = NewContext();

        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var restaurants = new BudgetItem { Name = "Restaurants", PlannedAmount = 200m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries, restaurants } },
            },
        });
        db.SaveChanges();

        // A split parent: 100 GBP @ 1.20 → 120 EUR, split 60/40 in its own currency.
        var parent = new Transaction
        {
            OwnerId = "user-1",
            BudgetItemId = null, // split → whole assignment cleared
            Amount = 100m,
            Currency = CurrencyCode.From("GBP"),
            ExchangeRate = 1.20m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(parent);
        db.SaveChanges();
        db.TransactionSplits.AddRange(
            new TransactionSplit { TransactionId = parent.Id, BudgetItemId = groceries.Id, Amount = 60m },
            new TransactionSplit { TransactionId = parent.Id, BudgetItemId = restaurants.Id, Amount = 40m });
        db.SaveChanges();

        var dto = await ReadJul26(db);
        var food = dto.Categories.Single(c => c.Name == "Food");

        food.Items.Single(i => i.Name == "Groceries").ActualAmount.Should().Be(72.00m);    // 60 × 1.20
        food.Items.Single(i => i.Name == "Restaurants").ActualAmount.Should().Be(48.00m); // 40 × 1.20
        food.TotalActual.Should().Be(120.00m); // the parent isn't counted twice
    }

    // DASH-050 — Overspent and zero-planned lines: spent is transaction-derived and Remaining
    // goes negative when spend exceeds planned (Restaurants 90 planned / 120 spent → -30) and
    // for a zero-planned line with spend (0 planned / 15 spent → -15).
    [Fact]
    public async Task OverspentAndZeroPlannedLines_ProduceNegativeRemaining()
    {
        await using var db = NewContext();

        var restaurants = new BudgetItem { Name = "Restaurants", PlannedAmount = 90m };
        var unplanned = new BudgetItem { Name = "Impulse", PlannedAmount = 0m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { restaurants, unplanned } },
            },
        });
        db.SaveChanges();

        db.Transactions.AddRange(
            new Transaction { OwnerId = "user-1", BudgetItemId = restaurants.Id, Amount = 120m, Type = TransactionType.Expense },
            new Transaction { OwnerId = "user-1", BudgetItemId = unplanned.Id, Amount = 15m, Type = TransactionType.Expense });
        db.SaveChanges();

        var dto = await ReadJul26(db);
        var food = dto.Categories.Single(c => c.Name == "Food");

        var restaurantsDto = food.Items.Single(i => i.Name == "Restaurants");
        restaurantsDto.ActualAmount.Should().Be(120m);
        restaurantsDto.Remaining.Should().Be(-30m); // "-€30.00 left" (rose)

        var unplannedDto = food.Items.Single(i => i.Name == "Impulse");
        unplannedDto.PlannedAmount.Should().Be(0m);
        unplannedDto.ActualAmount.Should().Be(15m);
        unplannedDto.Remaining.Should().Be(-15m); // "-€15.00 left" on a zero-planned line
    }

    // DASH-033 — Editing an income line's planned amount moves the pool: TotalIncome rises,
    // RemainingToBudget rises by the same delta, and the new planned amount is PERSISTED
    // (a fresh read reflects it).
    [Fact]
    public async Task EditingIncomePlanned_RaisesTotalIncomeAndRemaining_AndPersists()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        // Freelance 400 → 600 (+200).
        var result = await EditHandler(db).Handle(
            new UpdateBudgetItemCommand(ids.FreelanceId, PlannedAmount: 600m), CancellationToken.None);

        result.TotalIncome.Should().Be(3200m);       // 2,600 + 600
        result.TotalPlanned.Should().Be(1920m);       // unchanged — income isn't planned spend
        result.RemainingToBudget.Should().Be(1280m);  // 3,200 − 1,920
        result.IsBalanced.Should().BeFalse();

        // Persisted: a fresh read (and the derived income "received of planned" header) reflect it.
        var reread = await ReadJul26(db);
        reread.TotalIncome.Should().Be(3200m);
        var income = reread.Categories.Single(c => c.Kind == "Income");
        income.TotalPlanned.Should().Be(3200m);
        income.Items.Single(i => i.Id == ids.FreelanceId).PlannedAmount.Should().Be(600m);
    }

    // DASH-062 — Funding a jar counts toward Allotted: raising a savings (fund) line's planned
    // amount increases TotalPlanned and lowers RemainingToBudget, and the change persists.
    [Fact]
    public async Task FundingAJar_CountsTowardAllotted_LowersRemaining_AndPersists()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        // Holiday 150 → 300 (+150).
        var result = await EditHandler(db).Handle(
            new UpdateBudgetItemCommand(ids.HolidayId, PlannedAmount: 300m), CancellationToken.None);

        result.TotalIncome.Should().Be(3000m);        // income untouched
        result.TotalPlanned.Should().Be(2070m);       // 1,280 + 490 + 300 (savings contribution counts)
        result.RemainingToBudget.Should().Be(930m);   // 3,000 − 2,070
        result.IsBalanced.Should().BeFalse();

        var reread = await ReadJul26(db);
        reread.Categories.Single(c => c.Kind == "Savings").Items.Single(i => i.Id == ids.HolidayId)
            .PlannedAmount.Should().Be(300m);
    }

    // DASH-015 — Balanced month: assigning every euro (Groceries 400 → 1,480) drives Remaining
    // to exactly 0 with income present → IsBalanced true (the gold badge case). Savings
    // contributions are part of the balanced sum.
    [Fact]
    public async Task AssigningEveryEuro_BalancesTheMonth_WithIncomePresent()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        var result = await EditHandler(db).Handle(
            new UpdateBudgetItemCommand(ids.GroceriesId, PlannedAmount: 1480m), CancellationToken.None);

        result.TotalPlanned.Should().Be(3000m);       // 1,280 + (1,480 + 90) + 150
        result.RemainingToBudget.Should().Be(0m);
        result.IsBalanced.Should().BeTrue();          // income 3,000 > 0 AND remaining == 0 (PR #172)
    }

    // DASH-018 — Over-budgeted month: planning more than income (Rent 1,100 → 2,300) drives
    // RemainingToBudget negative and IsBalanced false (rose "…over-budgeted" case).
    [Fact]
    public async Task PlanningMoreThanIncome_GoesOverBudgeted()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        var result = await EditHandler(db).Handle(
            new UpdateBudgetItemCommand(ids.RentId, PlannedAmount: 2300m), CancellationToken.None);

        result.TotalPlanned.Should().Be(3120m);       // (2,300 + 180) + 490 + 150
        result.RemainingToBudget.Should().Be(-120m);  // "€120.00 over-budgeted"
        result.IsBalanced.Should().BeFalse();
    }

    // DASH-019 — One minor unit off is NOT balanced: Groceries 400 → 1,479.9999 leaves
    // Remaining 0.0001 (four-dp precision preserved server-side) so IsBalanced stays false
    // even though the currency display would round it to €0.00.
    [Fact]
    public async Task OneMinorUnitShort_IsNotBalanced()
    {
        await using var db = NewContext();
        var ids = SeedJul26(db);

        var result = await EditHandler(db).Handle(
            new UpdateBudgetItemCommand(ids.GroceriesId, PlannedAmount: 1479.9999m), CancellationToken.None);

        result.RemainingToBudget.Should().Be(0.0001m); // exactly one minor unit left
        result.IsBalanced.Should().BeFalse();          // honest integer math, no gold badge
    }
}
