using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Reports;
using AllotJar.Application.Reports.Dtos;
using AllotJar.Application.Reports.Queries.GetAnnualSummary;
using AllotJar.Application.Reports.Queries.GetBudgetTrends;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The report figures (rules 37–39, 41, W12), through the trends, annual and month-report
/// handlers, which all derive from <see cref="ReportFigures"/>: uncategorised spending and income
/// count by the transaction's own date (rule 37) so a month's total is the same before and after
/// categorising; a refund reduces spending in the month it was received (rules 38/39) and is
/// never income; received income is compared with budgeted income as a signed variance (rule 41).
/// </summary>
public class ReportFiguresTests
{
    private static readonly CurrentUserStub User = new("user-1");

    /// <summary>Income/Salary (planned 3000) and Household/Groceries (planned 400) + Clothes (planned 100).</summary>
    private static Dictionary<string, BudgetItem> SeedMonth(ApplicationDbContext db, int year, int month, decimal incomePlanned = 3000m)
    {
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = incomePlanned };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var clothes = new BudgetItem { Name = "Clothes", PlannedAmount = 100m, DisplayOrder = 1 };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { salary } },
                new() { Name = "Household", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { groceries, clothes } },
            },
        });
        db.SaveChanges();
        return new Dictionary<string, BudgetItem> { ["Salary"] = salary, ["Groceries"] = groceries, ["Clothes"] = clothes };
    }

    private static Transaction Seed(ApplicationDbContext db, DateOnly date, decimal amount, TransactionType type, Guid? lineId = null, Guid? refundOf = null, string payee = "Row")
    {
        var t = new Transaction { OwnerId = "user-1", Date = date, Payee = payee, Amount = amount, Type = type, BudgetItemId = lineId, RefundOfTransactionId = refundOf };
        db.Transactions.Add(t);
        db.SaveChanges();
        return t;
    }

    private static Task<MonthReportDto> Month(ApplicationDbContext db, int year, int month) =>
        new GetMonthReportQueryHandler(db, User).Handle(new GetMonthReportQuery(year, month), CancellationToken.None);

    private static Task<BudgetTrendsDto> Trends(ApplicationDbContext db) =>
        new GetBudgetTrendsQueryHandler(db, User).Handle(new GetBudgetTrendsQuery(6), CancellationToken.None);

    private static Task<AnnualSummaryDto> Annual(ApplicationDbContext db, int year) =>
        new GetAnnualSummaryQueryHandler(db, User).Handle(new GetAnnualSummaryQuery(year), CancellationToken.None);

    // ── Rule 37: 400 categorised + 100 not yet → the month reports 500 with 100 Uncategorised, flagged;
    // categorising the 100 later leaves the total at 500.
    [Fact]
    public async Task Uncategorised_IsIncludedAsItsOwnRow_AndTheTotalDoesNotMoveWhenCategorised()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        Seed(db, new DateOnly(2026, 9, 5), 400m, TransactionType.Expense, lines["Groceries"].Id);
        var loose = Seed(db, new DateOnly(2026, 9, 6), 100m, TransactionType.Expense, payee: "Unknown shop");

        var before = await Month(db, 2026, 9);
        before.Spent.Should().Be(500m);
        before.SpentCategorised.Should().Be(400m);
        before.SpentUncategorised.Should().Be(100m);
        before.UncategorisedCount.Should().Be(1);
        var row = before.Categories.Single(c => c.IsUncategorised);
        row.Name.Should().Be("Uncategorised");
        row.Kind.Should().Be("Uncategorised");
        row.Net.Should().Be(100m);
        row.Count.Should().Be(1);
        row.Index.Should().Be(-1);
        before.Categories.Single(c => c.Name == "Household").Index.Should().Be(0);

        var trends = await Trends(db);
        trends.Points.Single().Spent.Should().Be(500m);
        trends.Points.Single().SpentUncategorised.Should().Be(100m);
        trends.Points.Single().UncategorisedCount.Should().Be(1);
        (await Annual(db, 2026)).Months.Single(m => m.Month == 9).Spent.Should().Be(500m);

        await new AssignTransactionCommandHandler(db, User).Handle(
            new AssignTransactionCommand(loose.Id, lines["Clothes"].Id), CancellationToken.None);

        var after = await Month(db, 2026, 9);
        after.Spent.Should().Be(500m, "categorising moves money between rows, never out of the total");
        after.SpentCategorised.Should().Be(500m);
        after.SpentUncategorised.Should().Be(0m);
        after.UncategorisedCount.Should().Be(0);
        after.Categories.Should().NotContain(c => c.IsUncategorised);
    }

    [Fact]
    public async Task Uncategorised_CountsAMonthWithNoBudget_AndSlicesWhoseLineIsGone()
    {
        await using var db = NewContext();
        SeedMonth(db, 2026, 9);
        Seed(db, new DateOnly(2026, 10, 2), 70m, TransactionType.Expense); // October has no budget
        var split = Seed(db, new DateOnly(2026, 10, 3), 30m, TransactionType.Expense);
        db.TransactionSplits.AddRange(
            new TransactionSplit { TransactionId = split.Id, BudgetItemId = null, Amount = 10m },
            new TransactionSplit { TransactionId = split.Id, BudgetItemId = null, Amount = 20m });
        db.SaveChanges();

        var october = await Month(db, 2026, 10);
        october.HasBudget.Should().BeFalse();
        october.BaseCurrency.Should().BeNull();
        october.Spent.Should().Be(100m);
        october.SpentUncategorised.Should().Be(100m);
        october.UncategorisedCount.Should().Be(2, "the split whose slices are on no line is one more transaction to review (RP-P3-1)");

        var annual = await Annual(db, 2026);
        annual.Months.Single(m => m.Month == 10).HasBudget.Should().BeFalse();
        annual.Months.Single(m => m.Month == 10).Spent.Should().Be(100m);
        annual.Categories.Should().ContainSingle(c => c.Kind == "Uncategorised").Which.Total.Should().Be(100m);
        (await Trends(db)).Points.Should().ContainSingle(p => p.Key == "2026-09", "trends still cover budgeted months only");
    }

    // ── Rules 38/39: Sept 100 spent, Oct 20 refunded → Sept 100, Oct −20, combined 80; refunds labelled apart.
    [Fact]
    public async Task Refund_ReducesTheMonthItWasReceived_AndTheYearNets()
    {
        await using var db = NewContext();
        var sept = SeedMonth(db, 2026, 9);
        var oct = SeedMonth(db, 2026, 10);
        var purchase = Seed(db, new DateOnly(2026, 9, 25), 100m, TransactionType.Expense, sept["Groceries"].Id);
        Seed(db, new DateOnly(2026, 10, 3), 20m, TransactionType.Income, oct["Groceries"].Id, refundOf: purchase.Id);

        var september = await Month(db, 2026, 9);
        september.Spent.Should().Be(100m);
        september.Refunds.Should().Be(0m);

        var october = await Month(db, 2026, 10);
        october.Spent.Should().Be(-20m);
        october.Refunds.Should().Be(20m);
        october.IncomeReceived.Should().Be(0m, "a refund is never income");
        var household = october.Categories.Single(c => c.Name == "Household");
        household.Spent.Should().Be(0m);
        household.Refunds.Should().Be(20m);
        household.Net.Should().Be(-20m);

        var annual = await Annual(db, 2026);
        annual.TotalSpent.Should().Be(80m);
        annual.TotalRefunds.Should().Be(20m);
        annual.Categories.Single(c => c.Name == "Household").Total.Should().Be(80m);
        annual.Categories.Single(c => c.Name == "Household").Refunds.Should().Be(20m);

        var trends = await Trends(db);
        trends.TotalSpent.Should().Be(80m);
        trends.TotalRefunds.Should().Be(20m);
        trends.Points.Single(p => p.Month == 10).Refunds.Should().Be(20m);
    }

    [Fact]
    public async Task Refund_WithoutALine_ReducesTheUncategorisedRow_AndTheTotal()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        var purchase = Seed(db, new DateOnly(2026, 9, 5), 100m, TransactionType.Expense, lines["Groceries"].Id);
        Seed(db, new DateOnly(2026, 9, 6), 50m, TransactionType.Expense);
        Seed(db, new DateOnly(2026, 9, 7), 20m, TransactionType.Income, refundOf: purchase.Id);

        var month = await Month(db, 2026, 9);
        month.Spent.Should().Be(130m); // 100 + 50 − 20
        month.SpentCategorised.Should().Be(100m);
        month.SpentUncategorised.Should().Be(30m);
        month.Refunds.Should().Be(20m);
        month.UncategorisedCount.Should().Be(2, "the loose expense and the unplaced refund both need a line");
        var row = month.Categories.Single(c => c.IsUncategorised);
        row.Spent.Should().Be(50m);
        row.Refunds.Should().Be(20m);
        row.Net.Should().Be(30m);
        month.IncomeReceived.Should().Be(0m);
    }

    // ── Rule 41: received income counts uncategorised income and leaves out transfers and refunds;
    // Variance = received − budgeted, signed.
    [Theory]
    [InlineData(3200, 200)]
    [InlineData(2800, -200)]
    public async Task Income_ReceivedVsBudgeted_IsASignedVariance(decimal received, decimal variance)
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9, incomePlanned: 3000m);
        Seed(db, new DateOnly(2026, 9, 1), received - 100m, TransactionType.Income, lines["Salary"].Id);
        Seed(db, new DateOnly(2026, 9, 2), 100m, TransactionType.Income, payee: "Uncategorised side income");
        var purchase = Seed(db, new DateOnly(2026, 9, 5), 100m, TransactionType.Expense, lines["Groceries"].Id);
        Seed(db, new DateOnly(2026, 9, 6), 20m, TransactionType.Income, lines["Groceries"].Id, refundOf: purchase.Id);
        var a = new Account { OwnerId = "user-1", Name = "A" };
        var b = new Account { OwnerId = "user-1", Name = "B" };
        db.Accounts.AddRange(a, b);
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 9, 8), Payee = "Move", Amount = 500m, Type = TransactionType.Transfer,
            AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = new DateOnly(2026, 9, 8), ReceivedOn = new DateOnly(2026, 9, 8),
        });
        db.SaveChanges();

        var month = await Month(db, 2026, 9);
        month.IncomeBudgeted.Should().Be(3000m);
        month.IncomeReceived.Should().Be(received);
        month.IncomeUncategorised.Should().Be(100m);
        month.UncategorisedIncomeCount.Should().Be(1);
        month.Variance.Should().Be(variance);

        var trends = await Trends(db);
        trends.Points.Single().IncomeReceived.Should().Be(received);
        trends.Points.Single().Variance.Should().Be(variance);
        trends.TotalVariance.Should().Be(variance);

        var annual = await Annual(db, 2026);
        var september = annual.Months.Single(m => m.Month == 9);
        september.Income.Should().Be(3000m);
        september.IncomeReceived.Should().Be(received);
        september.Variance.Should().Be(variance);
        annual.TotalIncomeReceived.Should().Be(received);
        annual.TotalVariance.Should().Be(variance);
    }

    [Fact]
    public async Task MonthReport_LeavesPendingFxRowsOut_AndCountsThem()
    {
        await using var db = NewContext();
        var lines = SeedMonth(db, 2026, 9);
        Seed(db, new DateOnly(2026, 9, 5), 100m, TransactionType.Expense, lines["Groceries"].Id);
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 9, 6), Payee = "Abroad", Amount = 40m, Type = TransactionType.Expense,
            Currency = CurrencyCode.From("GBP"), FxPending = true,
        });
        db.SaveChanges();

        var month = await Month(db, 2026, 9);
        month.Spent.Should().Be(100m);
        month.UncategorisedCount.Should().Be(0);
        month.FxPendingCount.Should().Be(1);
        (await Trends(db)).Points.Single().FxPendingCount.Should().Be(1);
    }

    [Fact]
    public async Task MonthReport_IsOwnerScoped_AndRefusesAnImpossibleMonth()
    {
        await using var db = NewContext();
        SeedMonth(db, 2026, 9);
        db.Transactions.Add(new Transaction { OwnerId = "user-2", Date = new DateOnly(2026, 9, 6), Payee = "Theirs", Amount = 999m, Type = TransactionType.Expense });
        db.SaveChanges();

        (await Month(db, 2026, 9)).Spent.Should().Be(0m);

        var act = () => Month(db, 2026, 13);
        await act.Should().ThrowAsync<ValidationException>();
    }
}
