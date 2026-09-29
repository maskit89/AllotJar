using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetCategory;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Sinking funds: a Savings-kind group whose lines are jars. Planned contributions are
/// budgeted money in the plan totals only (rule 1); the grid's available balance is the jar's
/// actual ledger balance as of the viewed month's end (rule 48) — allocations in, jar-line
/// spending from the jar's account out (rule 79).
/// </summary>
public class SavingsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static BudgetMonth NewMonth(string ownerId, int year, int month) => new()
    {
        OwnerId = ownerId,
        Year = year,
        Month = month,
        BaseCurrency = CurrencyCode.Eur,
    };

    private static Jar SeedJar(ApplicationDbContext db, string ownerId, Guid id, Account account)
    {
        var jar = new Jar { Id = id, OwnerId = ownerId, Name = "Car", TargetAmount = 1000m, FundingAccountId = account.Id };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    [Fact]
    public async Task FundBalance_RollsOverAndSubtractsSpending()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedJar(db, "user-1", fundId, account);

        // May: 100 allocated to the Car jar (the planned 100 is the plan), spend nothing → balance 100.
        LedgerFixtures.Allocate(db, "user-1", account.Id, fundId, 100m, new DateOnly(2026, 5, 10));
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

        // June: another 100 allocated, and 30 spent from the account on the jar line → 100 + (100 − 30) = 170.
        LedgerFixtures.Allocate(db, "user-1", account.Id, fundId, 100m, new DateOnly(2026, 6, 10));
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

        LedgerFixtures.Expense(db, "user-1", account.Id, 30m, new DateOnly(2026, 6, 15), juneCar.Id);

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        var car = dto.Categories.Single(c => c.Kind == "Savings").Items.Single(i => i.Name == "Car");
        car.ActualAmount.Should().Be(30m);   // this month's spend
        car.SavingsAvailable.Should().Be(170m); // the jar's ledger balance as of 30 June
    }

    [Fact]
    public async Task FundBalance_OnlyCountsMoneyUpToTheEndOfTheViewedMonth()
    {
        // Rule 48: a past month shows the jar as of its month-end; later money is excluded.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedJar(db, "user-1", fundId, account);
        LedgerFixtures.Allocate(db, "user-1", account.Id, fundId, 100m, new DateOnly(2026, 6, 10));
        LedgerFixtures.Allocate(db, "user-1", account.Id, fundId, 100m, new DateOnly(2026, 7, 10));

        var june = NewMonth("user-1", 2026, 6);
        june.Categories.Add(new BudgetCategory
        {
            Name = "Funds", Kind = CategoryKind.Savings,
            Items = new List<BudgetItem> { new() { Name = "Car", SavingsId = fundId, PlannedAmount = 100m } },
        });
        // A LATER month's allocation must not leak into June's balance.
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
    public async Task AddItem_ToAFundGroup_IsRefused_SavingsLinesComeFromCreateJar()
    {
        // Rule 73: a savings line is a jar, which needs its account; the jar form plants the line.
        await using var db = NewContext();
        var month = NewMonth("user-1", 2026, 6);
        var funds = new BudgetCategory { Name = "Funds", Kind = CategoryKind.Savings };
        month.Categories.Add(funds);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();

        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));
        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new AddBudgetItemCommand(funds.Id, "Holiday", 50m), CancellationToken.None));

        (await db.BudgetItems.AnyAsync(i => i.Name == "Holiday")).Should().BeFalse();
        db.Jars.Should().BeEmpty();
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
