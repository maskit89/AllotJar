using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetCategory;
using AllotJar.Application.Budgets.Commands.DeleteBudgetCategory;
using AllotJar.Application.Budgets.Commands.RenameBudgetCategory;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Exercises category-group management (create / rename / delete) against the
/// EF Core in-memory provider: new groups are expenses that append after the
/// existing ones, the Income group is protected, and a user can never mutate
/// another user's budget.
/// </summary>
public class BudgetCategoryCrudHandlerTests
{
    private sealed class CurrentUserStub : ICurrentUser
    {
        public CurrentUserStub(string? userId) => UserId = userId;
        public string? UserId { get; }
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    private sealed record Seeded(Guid MonthId, Guid IncomeCategoryId, Guid HousingCategoryId);

    // Income(Take-home Pay 3000) + Housing(Rent 1000).
    private static Seeded Seed(ApplicationDbContext db, string ownerId)
    {
        var income = new BudgetCategory
        {
            Name = "Income",
            Kind = CategoryKind.Income,
            DisplayOrder = 0,
            Items = new List<BudgetItem> { new() { Name = "Take-home Pay", PlannedAmount = 3000m } },
        };
        var housing = new BudgetCategory
        {
            Name = "Housing",
            DisplayOrder = 0,
            Items = new List<BudgetItem> { new() { Name = "Rent", PlannedAmount = 1000m } },
        };
        var month = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory> { income, housing },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return new Seeded(month.Id, income.Id, housing.Id);
    }

    [Fact]
    public async Task Add_CreatesExpenseGroup_AppendedAfterExistingExpenses()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetCategoryCommand(s.MonthId, "Subscriptions"), CancellationToken.None);

        var created = result.Categories.Single(c => c.Name == "Subscriptions");
        created.Kind.Should().Be("Expense");
        created.DisplayOrder.Should().Be(1);       // after Housing at 0
        created.Items.Should().BeEmpty();
        result.TotalIncome.Should().Be(3000m);     // unchanged
        result.RemainingToBudget.Should().Be(2000m);
    }

    [Fact]
    public async Task Add_Throws_WhenUserDoesNotOwnTheMonth()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new AddBudgetCategoryCommand(s.MonthId, "Sneaky"), CancellationToken.None));
    }

    [Fact]
    public async Task Add_Throws_WhenMonthDoesNotExist()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new AddBudgetCategoryCommand(Guid.NewGuid(), "Ghost"), CancellationToken.None));
    }

    [Fact]
    public async Task Rename_ChangesTheName()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new RenameBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new RenameBudgetCategoryCommand(s.HousingCategoryId, "Home"), CancellationToken.None);

        result.Categories.Should().Contain(c => c.Id == s.HousingCategoryId && c.Name == "Home");
    }

    [Fact]
    public async Task Rename_Throws_WhenUserDoesNotOwnTheCategory()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new RenameBudgetCategoryCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new RenameBudgetCategoryCommand(s.HousingCategoryId, "Hacked"), CancellationToken.None));
    }

    [Fact]
    public async Task Delete_RemovesGroupAndItsLines()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new DeleteBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new DeleteBudgetCategoryCommand(s.HousingCategoryId), CancellationToken.None);

        result.Categories.Should().NotContain(c => c.Id == s.HousingCategoryId);
        result.TotalPlanned.Should().Be(0m);          // Housing's Rent is gone
        result.RemainingToBudget.Should().Be(3000m);  // all income now unassigned
        (await db.BudgetItems.CountAsync()).Should().Be(1); // only the income line remains
    }

    [Fact]
    public async Task Delete_Throws_WhenDeletingTheIncomeGroup()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new DeleteBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new DeleteBudgetCategoryCommand(s.IncomeCategoryId), CancellationToken.None));
    }

    [Fact]
    public async Task Delete_Throws_WhenUserDoesNotOwnTheCategory()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new DeleteBudgetCategoryCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new DeleteBudgetCategoryCommand(s.HousingCategoryId), CancellationToken.None));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void AddValidator_RejectsEmptyName(string name)
    {
        var validator = new AddBudgetCategoryCommandValidator();
        var result = validator.Validate(new AddBudgetCategoryCommand(Guid.NewGuid(), name));
        result.IsValid.Should().BeFalse();
    }
}
