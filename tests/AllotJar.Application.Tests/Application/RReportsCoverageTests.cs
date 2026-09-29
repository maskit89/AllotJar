using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Queries.GetAnnualSummary;
using AllotJar.Application.Reports.Queries.GetBudgetTrends;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Extra coverage for the REPORTS area (catalog prefix RPT, docs/testing/cases/18-reports.md)
/// at the Application/domain layer — the money-integrity and windowing gaps left by
/// <see cref="BudgetTrendsTests"/> and <see cref="AnnualSummaryTests"/>:
/// the "most recent N budgets" window over non-contiguous months + the 1..24 clamp; the
/// deliberate budgeted-income (annual) vs received-income (trends) split; (Name, Kind) category
/// keying incl. the rename-split and same-name-different-kind paths; the Savings kind counting as
/// spend; and the read-time-derived sum invariants — a split counted once, transfers excluded,
/// deletions retroactively lowering the report, plus the PR #172 blank-jar-month (Planned &gt; 0,
/// Income = 0) point and OwnerId (not login) scoping. Pure UI/formatting cases (hero maths, 2%
/// sliver, bar scaling, error banners, feature-flag 404 vs 401) stay in the client / controller
/// suites.
/// </summary>
public class RReportsCoverageTests
{
    /// <summary>A login whose id differs from the household partition key it reads — e.g. a
    /// Read-only member of someone else's household. Reports scope by <see cref="OwnerId"/>.</summary>
    private sealed class MemberStub(string userId, string ownerId, HouseholdRole role) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId { get; } = ownerId;
        public HouseholdRole? Role { get; } = role;
    }

    /// <summary>
    /// Seeds one budget month. When <paramref name="incomePlanned"/>/<paramref name="incomeReceived"/>
    /// is non-zero an Income group with a "Salary" line is added (received income is recorded as an
    /// assigned Income transaction). Each entry in <paramref name="lines"/> becomes its own category
    /// (Name == the line name, so annual grouping keys on it), and any non-zero Spent is recorded as
    /// an assigned Expense transaction — the same way every other read derives actuals.
    /// </summary>
    private static BudgetMonth SeedMonth(
        ApplicationDbContext db, string ownerId, int year, int month,
        decimal incomePlanned = 0m, decimal incomeReceived = 0m,
        IEnumerable<(string Name, CategoryKind Kind, decimal Planned, decimal Spent)>? lines = null)
    {
        var categories = new List<BudgetCategory>();
        BudgetItem? salary = null;
        if (incomePlanned > 0m || incomeReceived > 0m)
        {
            salary = new BudgetItem { Name = "Salary", PlannedAmount = incomePlanned };
            categories.Add(new BudgetCategory
            {
                Name = "Income", Kind = CategoryKind.Income,
                Items = new List<BudgetItem> { salary },
            });
        }

        var spendItems = new List<(BudgetItem Item, decimal Spent)>();
        foreach (var line in lines ?? Enumerable.Empty<(string, CategoryKind, decimal, decimal)>())
        {
            var item = new BudgetItem
            {
                Name = line.Name,
                PlannedAmount = line.Planned,
                SavingsId = line.Kind == CategoryKind.Savings ? Guid.NewGuid() : null,
            };
            categories.Add(new BudgetCategory
            {
                Name = line.Name, Kind = line.Kind,
                Items = new List<BudgetItem> { item },
            });
            spendItems.Add((item, line.Spent));
        }

        var m = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
            Categories = categories,
        };
        db.BudgetMonths.Add(m);
        db.SaveChanges();

        if (incomeReceived > 0m && salary is not null)
        {
            db.Transactions.Add(new Transaction
            {
                OwnerId = ownerId, BudgetItemId = salary.Id,
                Amount = incomeReceived, Type = TransactionType.Income,
                Date = new DateOnly(year, month, 1),
            });
        }

        foreach (var (item, spent) in spendItems)
        {
            if (spent != 0m)
            {
                db.Transactions.Add(new Transaction
                {
                    OwnerId = ownerId, BudgetItemId = item.Id,
                    Amount = spent, Type = TransactionType.Expense,
                    Date = new DateOnly(year, month, 2),
                });
            }
        }

        db.SaveChanges();
        return m;
    }

    private static Task<AllotJar.Application.Reports.Dtos.BudgetTrendsDto> Trends(
        ApplicationDbContext db, ICurrentUser user, int months = 6) =>
        new GetBudgetTrendsQueryHandler(db, user).Handle(new GetBudgetTrendsQuery(months), CancellationToken.None);

    private static Task<AllotJar.Application.Reports.Dtos.AnnualSummaryDto> Annual(
        ApplicationDbContext db, ICurrentUser user, int year) =>
        new GetAnnualSummaryQueryHandler(db, user).Handle(new GetAnnualSummaryQuery(year), CancellationToken.None);

    // ── RPT-009: the trend window is the most recent N BUDGETS, not the last N calendar months —
    // a user with budgets only in Jan and Jun gets exactly two points sitting side-by-side
    // (Feb–May are not rendered as empty gaps), in chronological order.
    [Fact]
    public async Task Trends_Window_IsMostRecentBudgets_NotCalendarMonths_SoGapsCollapse()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 1, incomePlanned: 3000m,
            lines: new[] { ("Housing", CategoryKind.Expense, 1000m, 900m) });
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m,
            lines: new[] { ("Housing", CategoryKind.Expense, 1000m, 950m) });

        var dto = await Trends(db, user);

        dto.Points.Should().HaveCount(2); // no Feb–May filler points
        dto.Points.Select(p => p.Key).Should().Equal("2026-01", "2026-06"); // chronological, gap collapsed
    }

    // ── RPT-010: the client always asks for 6, so nine consecutive budgets return the six most
    // recent (oldest windowed out), chronological.
    [Fact]
    public async Task Trends_TakesTheSixMostRecentBudgets_WhenNineExist()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        // Nov 2025 → Jul 2026 (nine consecutive months).
        SeedMonth(db, "user-1", 2025, 11, incomePlanned: 3000m);
        SeedMonth(db, "user-1", 2025, 12, incomePlanned: 3000m);
        for (var mo = 1; mo <= 7; mo++)
        {
            SeedMonth(db, "user-1", 2026, mo, incomePlanned: 3000m);
        }

        var dto = await Trends(db, user, months: 6);

        dto.Points.Select(p => p.Key)
            .Should().Equal("2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07");
    }

    // ── RPT-010: the server silently Math.Clamp-s months to 1..24 — 0 and negatives collapse to a
    // single (most-recent) point, an over-large window returns everything available; it never throws.
    [Theory]
    [InlineData(0, 1)]
    [InlineData(-3, 1)]
    [InlineData(99, 9)] // clamped to 24, but only nine budgets exist
    public async Task Trends_ClampsTheWindowToOneOrTwentyFour_NeverThrowing(int requested, int expectedPoints)
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2025, 11, incomePlanned: 3000m);
        SeedMonth(db, "user-1", 2025, 12, incomePlanned: 3000m);
        for (var mo = 1; mo <= 7; mo++)
        {
            SeedMonth(db, "user-1", 2026, mo, incomePlanned: 3000m);
        }

        var dto = await Trends(db, user, months: requested);

        dto.Points.Should().HaveCount(expectedPoints);
        if (requested <= 0)
        {
            dto.Points.Single().Key.Should().Be("2026-07"); // the most recent budget
        }
    }

    // ── RPT-015 (rule 41, W12): the annual table and the trends carry the SAME budgeted income
    // (€3,000), received income (€2,950) and signed variance (−50) for a month — the two reports
    // no longer diverge, and the annual Net is received − spent.
    [Fact]
    public async Task Annual_AndTrends_ReportTheSameBudgetedAndReceivedIncome_ForTheSameMonth()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m,
            lines: new[] { ("Housing", CategoryKind.Expense, 2400m, 2400m) });

        var annual = await Annual(db, user, 2026);
        var june = annual.Months.Single(m => m.Month == 6);
        june.Income.Should().Be(3000m);          // budgeted
        june.IncomeReceived.Should().Be(2950m);  // received
        june.Variance.Should().Be(-50m);
        june.Spent.Should().Be(2400m);           // actual
        annual.TotalIncome.Should().Be(3000m);
        annual.TotalIncomeReceived.Should().Be(2950m);

        var trends = await Trends(db, user);
        var trendJune = trends.Points.Single();
        trendJune.Income.Should().Be(3000m);
        trendJune.IncomeReceived.Should().Be(2950m);
        trendJune.Variance.Should().Be(-50m);
    }

    // ── RPT-016 (+ the RPT-014 "average card disappears" server contract): the annual endpoint has
    // an :int route constraint but no range check — year 0, 9999 and negatives all return a full 12
    // hasBudget:false months, zero totals, zero budgeted months and an EMPTY categories list.
    [Theory]
    [InlineData(0)]
    [InlineData(9999)]
    [InlineData(-5)]
    public async Task Annual_UnvalidatedYear_ReturnsTwelveEmptyMonthsAndNoCategories(int year)
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m,
            lines: new[] { ("Housing", CategoryKind.Expense, 1000m, 900m) }); // real data in a different year

        var dto = await Annual(db, user, year);

        dto.Year.Should().Be(year);
        dto.Months.Should().HaveCount(12);
        dto.Months.Should().OnlyContain(m => !m.HasBudget);
        dto.TotalIncome.Should().Be(0m);
        dto.TotalPlanned.Should().Be(0m);
        dto.TotalSpent.Should().Be(0m);
        dto.BudgetedMonths.Should().Be(0);
        dto.Categories.Should().BeEmpty(); // the client drops the Average-spending card on this
    }

    // ── RPT-017: the average-by-category list is ordered by average descending, each carrying its
    // yearly total; the Savings category is included with Kind "Savings" (the client's violet "Fund"
    // badge) while the Income group is excluded. Averaged over the 2 budgeted months.
    [Fact]
    public async Task Annual_AverageCategories_OrderedByAverageDesc_IncludeSavings_ExcludeIncome()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 5, incomePlanned: 3000m, incomeReceived: 2900m, lines: new[]
        {
            ("Housing", CategoryKind.Expense, 1400m, 1400m),
            ("Food", CategoryKind.Expense, 700m, 1000m),
            ("Emergency Fund", CategoryKind.Savings, 300m, 300m),
        });
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m, lines: new[]
        {
            ("Housing", CategoryKind.Expense, 1500m, 1400m),
            ("Food", CategoryKind.Expense, 800m, 700m),
            ("Emergency Fund", CategoryKind.Savings, 300m, 300m),
        });

        var dto = await Annual(db, user, 2026);

        dto.BudgetedMonths.Should().Be(2);
        dto.Categories.Select(c => c.Name).Should().Equal("Housing", "Food", "Emergency Fund"); // avg desc

        var housing = dto.Categories.Single(c => c.Name == "Housing");
        housing.Total.Should().Be(2800m);
        housing.AveragePerMonth.Should().Be(1400m);

        var food = dto.Categories.Single(c => c.Name == "Food");
        food.Total.Should().Be(1700m);
        food.AveragePerMonth.Should().Be(850m);

        var fund = dto.Categories.Single(c => c.Name == "Emergency Fund");
        fund.Kind.Should().Be("Savings"); // the only "Fund"-badged row
        fund.Total.Should().Be(600m);
        fund.AveragePerMonth.Should().Be(300m);

        dto.Categories.Should().NotContain(c => c.Name == "Income" || c.Name == "Salary");
    }

    // ── RPT-018 / RPT-036: a single-budget year averages each category over exactly one month, so
    // the average equals that month's actual, and the trend has a single point.
    [Fact]
    public async Task Annual_SingleBudgetedMonth_AveragesEqualThatMonthsActuals()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m,
            lines: new[] { ("Housing", CategoryKind.Expense, 1500m, 2400m) });

        var dto = await Annual(db, user, 2026);
        dto.BudgetedMonths.Should().Be(1);
        var housing = dto.Categories.Single(c => c.Name == "Housing");
        housing.AveragePerMonth.Should().Be(2400m); // == the single month's actual (round(2400 / 1))
        housing.Total.Should().Be(2400m);

        var trends = await Trends(db, user);
        trends.Points.Should().ContainSingle();
    }

    // ── RPT-019 (rename half): categories are keyed by (Name, Kind), so renaming an expense group
    // mid-year splits the year's spend across two rows — the old name (Jan–Mar) and the new name
    // (Apr–May) — each averaged over the SAME budgetedMonths denominator (5).
    [Fact]
    public async Task Annual_RenamedCategory_SplitsIntoTwoRowsByName()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        foreach (var mo in new[] { 1, 2, 3 })
        {
            SeedMonth(db, "user-1", 2026, mo, incomePlanned: 3000m,
                lines: new[] { ("Groceries", CategoryKind.Expense, 300m, 100m) });
        }
        foreach (var mo in new[] { 4, 5 })
        {
            SeedMonth(db, "user-1", 2026, mo, incomePlanned: 3000m,
                lines: new[] { ("Food", CategoryKind.Expense, 300m, 200m) });
        }

        var dto = await Annual(db, user, 2026);

        dto.BudgetedMonths.Should().Be(5);
        var groceries = dto.Categories.Single(c => c.Name == "Groceries");
        groceries.Total.Should().Be(300m);            // 3 × 100 (Jan–Mar)
        groceries.AveragePerMonth.Should().Be(60m);   // ÷ 5 budgeted months
        var food = dto.Categories.Single(c => c.Name == "Food");
        food.Total.Should().Be(400m);                 // 2 × 200 (Apr–May)
        food.AveragePerMonth.Should().Be(80m);        // ÷ 5 budgeted months
        dto.Categories.Should().HaveCount(2);
    }

    // ── RPT-019 (kind half): the same NAME under two Kinds is two distinct rows — an Expense "Food"
    // and a Savings "Food" never merge, and only the Savings one is tagged "Savings" (the Fund badge).
    [Fact]
    public async Task Annual_SameNameDifferentKind_AreTwoSeparateRows()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, lines: new[]
        {
            ("Food", CategoryKind.Expense, 400m, 200m),
            ("Food", CategoryKind.Savings, 100m, 50m),
        });

        var dto = await Annual(db, user, 2026);

        var foodRows = dto.Categories.Where(c => c.Name == "Food").ToList();
        foodRows.Should().HaveCount(2);
        foodRows.Single(c => c.Kind == "Expense").Total.Should().Be(200m);
        foodRows.Single(c => c.Kind == "Savings").Total.Should().Be(50m);
        foodRows.Count(c => c.Kind == "Savings").Should().Be(1);
    }

    // ── RPT-024 (P0): a split transaction is counted ONCE. A €120 expense split €80 → Food /
    // €40 → Housing lands €80 and €40 on those lines — the parent (BudgetItemId == null) is never
    // added on top — so the month gains exactly €120 across Spent (trend + annual + breakdown),
    // not €240.
    [Fact]
    public async Task Split_IsCountedOnceAcrossItsLines_InTrendAnnualAndBreakdown()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var june = SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, lines: new[]
        {
            ("Housing", CategoryKind.Expense, 1500m, 0m),
            ("Food", CategoryKind.Expense, 800m, 0m),
        });
        var housing = june.Categories.Single(c => c.Name == "Housing").Items.Single();
        var food = june.Categories.Single(c => c.Name == "Food").Items.Single();

        var parent = new Transaction
        {
            OwnerId = "user-1", Amount = 120m, Type = TransactionType.Expense,
            Date = new DateOnly(2026, 6, 10), Payee = "Supermarket",
        };
        db.Transactions.Add(parent);
        await db.SaveChangesAsync();

        await new SplitTransactionCommandHandler(db, user).Handle(
            new SplitTransactionCommand(parent.Id, new List<SplitAllocationInput>
            {
                new(food.Id, 80m),
                new(housing.Id, 40m),
            }),
            CancellationToken.None);

        // Breakdown source (/budget/{y}/{m}) — each line carries only its own slice.
        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        month.Categories.Single(c => c.Name == "Food").TotalActual.Should().Be(80m);
        month.Categories.Single(c => c.Name == "Housing").TotalActual.Should().Be(40m);

        // Trend + annual Spent gain exactly €120 (80 + 40), not €240.
        (await Trends(db, user)).Points.Single().Spent.Should().Be(120m);
        (await Annual(db, user, 2026)).Months.Single(m => m.Month == 6).Spent.Should().Be(120m);
    }

    // ── RPT-025 (P0): a transfer is in NO report figure. Even force-assigned to the Food line, a
    // Type=Transfer row rolls up into neither Spent nor IncomeReceived — BudgetActuals groups by
    // (line, Type) and only counts the line's own Income/Expense kind.
    [Fact]
    public async Task Transfer_IsExcludedFromEveryReportFigure_EvenWhenAssignedToALine()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var june = SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m, lines: new[]
        {
            ("Housing", CategoryKind.Expense, 1500m, 1400m),
            ("Food", CategoryKind.Expense, 800m, 700m),
        });
        var food = june.Categories.Single(c => c.Name == "Food").Items.Single();

        // A €500 transfer between two accounts — force-assigned to Food to prove it still counts 0.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", BudgetItemId = food.Id, Amount = 500m, Type = TransactionType.Transfer,
            AccountId = Guid.NewGuid(), TransferAccountId = Guid.NewGuid(),
            Date = new DateOnly(2026, 6, 12),
        });
        await db.SaveChangesAsync();

        var trends = await Trends(db, user);
        trends.Points.Single().Spent.Should().Be(2100m);          // 1400 + 700, transfer excluded
        trends.Points.Single().IncomeReceived.Should().Be(2950m); // transfer not counted as income
        (await Annual(db, user, 2026)).Months.Single(m => m.Month == 6).Spent.Should().Be(2100m);
    }

    // ── RPT-026: reports are transaction-derived at READ time — deleting a historical €100 Food
    // expense retroactively lowers the June Spent (trend + annual) and the Food breakdown, with no
    // stored snapshot preserving the old figure.
    [Fact]
    public async Task Reports_AreDerivedAtReadTime_SoDeletingATransactionLowersThem()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var june = SeedMonth(db, "user-1", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m, lines: new[]
        {
            ("Housing", CategoryKind.Expense, 1500m, 1400m),
            ("Food", CategoryKind.Expense, 800m, 600m),
            ("Emergency Fund", CategoryKind.Savings, 300m, 300m),
        });
        var food = june.Categories.Single(c => c.Name == "Food").Items.Single();
        var extra = new Transaction
        {
            OwnerId = "user-1", BudgetItemId = food.Id, Amount = 100m, Type = TransactionType.Expense,
            Date = new DateOnly(2026, 6, 20),
        };
        db.Transactions.Add(extra);
        await db.SaveChangesAsync();

        (await Trends(db, user)).Points.Single().Spent.Should().Be(2400m);        // 1400 + 700 + 300
        (await Annual(db, user, 2026)).Months.Single(m => m.Month == 6).Spent.Should().Be(2400m);

        db.Transactions.Remove(extra); // delete the €100 Food expense
        await db.SaveChangesAsync();

        (await Trends(db, user)).Points.Single().Spent.Should().Be(2300m);        // recomputed, −100
        var annual = await Annual(db, user, 2026);
        annual.Months.Single(m => m.Month == 6).Spent.Should().Be(2300m);
        annual.Categories.Single(c => c.Name == "Food").Total.Should().Be(600m);  // 700 − 100
        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        month.Categories.Single(c => c.Name == "Food").TotalActual.Should().Be(600m);
    }

    // ── RPT-037 (PR #172): a blank current month for a jar-owning household reports OVER-budgeted,
    // not empty — the accrual-planned savings lines give the trend point Planned > 0 while Income and
    // IncomeReceived stay 0 and Spent is 0. It is NOT windowed out as empty (there IS a data point).
    [Fact]
    public async Task BlankJarMonth_ReportsPlannedWithoutIncome_NotAsEmpty()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        // A blank July: no income entered, but a jar-backed Savings line carries an accrual plan.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Emergency Fund", PlannedAmount = 300m, SavingsId = Guid.NewGuid() },
                    },
                },
            },
        });
        await db.SaveChangesAsync();

        var trends = await Trends(db, user);
        var july = trends.Points.Single();
        july.Income.Should().Be(0m);
        july.IncomeReceived.Should().Be(0m);
        july.Planned.Should().Be(300m); // accrual-planned savings → over-budgeted, not balanced/empty
        july.Spent.Should().Be(0m);

        var annual = await Annual(db, user, 2026);
        var annualJuly = annual.Months.Single(m => m.Month == 7);
        annualJuly.HasBudget.Should().BeTrue();
        annualJuly.Income.Should().Be(0m);
        annualJuly.Planned.Should().Be(300m);
        annualJuly.Spent.Should().Be(0m);
    }

    // ── RPT-034: reports are scoped by the household partition key (OwnerId), not the caller's
    // login — so a Read-only member reading someone else's household sees that household's figures,
    // and never their own login-id-stamped decoy data. (Role never gates a report query.)
    [Fact]
    public async Task Reports_AreOwnerScoped_SoAMemberSeesTheHouseholdData_NotTheirOwnLoginData()
    {
        await using var db = NewContext();
        // The household's real data, stamped with the owner's id.
        SeedMonth(db, "household-owner", 2026, 6, incomePlanned: 3000m, incomeReceived: 2950m,
            lines: new[] { ("Housing", CategoryKind.Expense, 1500m, 1400m) });
        // A decoy stamped with the member's own LOGIN id — must never surface.
        SeedMonth(db, "member-login", 2026, 6, incomePlanned: 9000m,
            lines: new[] { ("Housing", CategoryKind.Expense, 9000m, 999m) });

        var member = new MemberStub("member-login", "household-owner", HouseholdRole.ReadOnly);
        var dto = await Trends(db, member);

        dto.Points.Should().ContainSingle();
        dto.Points.Single().Spent.Should().Be(1400m);          // the household's figure
        dto.Points.Single().IncomeReceived.Should().Be(2950m);
        dto.TotalSpent.Should().Be(1400m);                     // not the 999 decoy
    }
}
