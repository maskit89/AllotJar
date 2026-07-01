using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetCategory;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Sinking funds: a Fund-kind group whose lines carry a balance across months.
/// Contributions (planned) count as budgeted money; spending (actual) draws the
/// balance down; the available balance rolls over month to month.
/// </summary>
public class SavingsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-savings-{Guid.NewGuid()}")
            .Options);

    private static BudgetMonth NewMonth(string ownerId, int year, int month) => new()
    {
        OwnerId = ownerId,
        Year = year,
        Month = month,
        BaseCurrency = CurrencyCode.Eur,
    };

    [Fact]
    public async Task FundBalance_RollsOverAndSubtractsSpending()
    {
        await using var db = NewContext();
        var fundId = Guid.NewGuid();

        // May: contribute 100 to the Car fund, spend nothing → balance 100.
        var may = NewMonth("user-1", 2026, 5);
        may.Categories.Add(new BudgetCategory
        {
            Name = "Funds",
            Kind = CategoryKind.Savings,
            Items = new List<BudgetItem>
            {
                new() { Name = "Car", SavingsId = fundId, PlannedAmount = 100m },
            },
        });

        // June: contribute another 100, and spend 30 (tracked) → carry 100 + (100 - 30) = 170.
        var june = NewMonth("user-1", 2026, 6);
        var juneCar = new BudgetItem
        {
            Name = "Car",
            SavingsId = fundId,
            PlannedAmount = 100m,
        };
        june.Categories.Add(new BudgetCategory
        {
            Name = "Funds",
            Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { juneCar },
        });

        db.BudgetMonths.AddRange(may, june);
        await db.SaveChangesAsync();

        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            BudgetItemId = juneCar.Id,
            Amount = 30m,
            Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        var car = dto.Categories.Single(c => c.Kind == "Savings").Items.Single(i => i.Name == "Car");
        car.ActualAmount.Should().Be(30m);   // this month's spend
        car.SavingsAvailable.Should().Be(170m); // rolled-over available balance
    }

    [Fact]
    public async Task FundBalance_OnlyCountsMonthsUpToAndIncludingTheViewedOne()
    {
        await using var db = NewContext();
        var fundId = Guid.NewGuid();

        var june = NewMonth("user-1", 2026, 6);
        june.Categories.Add(new BudgetCategory
        {
            Name = "Funds", Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { new() { Name = "Car", SavingsId = fundId, PlannedAmount = 100m } },
        });
        // A FUTURE month's contribution must not leak into June's balance.
        var july = NewMonth("user-1", 2026, 7);
        july.Categories.Add(new BudgetCategory
        {
            Name = "Funds", Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { new() { Name = "Car", SavingsId = fundId, PlannedAmount = 100m } },
        });
        db.BudgetMonths.AddRange(june, july);
        await db.SaveChangesAsync();

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        dto.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable.Should().Be(100m);
    }

    [Fact]
    public async Task FundContributions_CountTowardTotalPlannedAndRemaining()
    {
        await using var db = NewContext();
        var month = NewMonth("user-1", 2026, 6);
        month.Categories.Add(new BudgetCategory
        {
            Name = "Income", Kind = CategoryKind.Income,
            Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } },
        });
        month.Categories.Add(new BudgetCategory
        {
            Name = "Funds", Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { new() { Name = "Car", SavingsId = Guid.NewGuid(), PlannedAmount = 100m } },
        });
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        dto.TotalIncome.Should().Be(1000m);
        dto.TotalPlanned.Should().Be(100m);       // the fund contribution is budgeted money
        dto.RemainingToBudget.Should().Be(900m);
    }

    [Fact]
    public async Task AddCategory_CanCreateAFundGroup()
    {
        await using var db = NewContext();
        var month = NewMonth("user-1", 2026, 6);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();

        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new AddBudgetCategoryCommand(month.Id, "Sinking Funds", CategoryKind.Savings), CancellationToken.None);

        dto.Categories.Should().ContainSingle(c => c.Kind == "Savings" && c.Name == "Sinking Funds");
    }

    [Fact]
    public async Task AddItem_ToAFundGroup_AssignsAFundId()
    {
        await using var db = NewContext();
        var month = NewMonth("user-1", 2026, 6);
        var funds = new BudgetCategory { Name = "Funds", Kind = CategoryKind.Savings };
        month.Categories.Add(funds);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();

        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new AddBudgetItemCommand(funds.Id, "Holiday", 50m), CancellationToken.None);

        var line = await db.BudgetItems.SingleAsync(i => i.Name == "Holiday");
        line.SavingsId.Should().NotBeNull();
    }

    [Fact]
    public async Task AddItem_ToAnExpenseGroup_LeavesFundIdNull()
    {
        await using var db = NewContext();
        var month = NewMonth("user-1", 2026, 6);
        var expenses = new BudgetCategory { Name = "Housing", Kind = CategoryKind.Expense };
        month.Categories.Add(expenses);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();

        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new AddBudgetItemCommand(expenses.Id, "Rent", 800m), CancellationToken.None);

        (await db.BudgetItems.SingleAsync(i => i.Name == "Rent")).SavingsId.Should().BeNull();
    }

    [Fact]
    public async Task CreateBudgetMonth_CopiesFundIdSoTheFundIsTheSameAcrossMonths()
    {
        await using var db = NewContext();
        var fundId = Guid.NewGuid();
        var may = NewMonth("user-1", 2026, 5);
        may.Categories.Add(new BudgetCategory
        {
            Name = "Funds", Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { new() { Name = "Car", SavingsId = fundId, PlannedAmount = 100m } },
        });
        db.BudgetMonths.Add(may);
        await db.SaveChangesAsync();

        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneCar = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.Name == "Car" && i.BudgetCategory.BudgetMonth.Month == 6);
        juneCar.SavingsId.Should().Be(fundId);
    }

    [Fact]
    public void AddCategory_Validator_RejectsIncomeKind()
    {
        var validator = new AddBudgetCategoryCommandValidator();
        validator
            .Validate(new AddBudgetCategoryCommand(Guid.NewGuid(), "Income", CategoryKind.Income))
            .IsValid.Should().BeFalse();
    }
}
