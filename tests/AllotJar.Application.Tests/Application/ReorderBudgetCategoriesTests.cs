using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.ReorderBudgetCategories;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

public class ReorderBudgetCategoriesTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private sealed record Seeded(Guid MonthId, Guid Housing, Guid Food, Guid Savings);

    // Expense groups Housing(0), Food(1), Savings(2) under one month.
    private static Seeded Seed(ApplicationDbContext db, string ownerId)
    {
        var housing = new BudgetCategory { Name = "Housing", DisplayOrder = 0 };
        var food = new BudgetCategory { Name = "Food", DisplayOrder = 1 };
        var savings = new BudgetCategory { Name = "Savings", DisplayOrder = 2 };
        var month = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory> { housing, food, savings },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return new Seeded(month.Id, housing.Id, food.Id, savings.Id);
    }

    [Fact]
    public async Task Reorder_SetsDisplayOrder_ToMatchTheGivenOrder()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetCategoriesCommandHandler(db, new CurrentUserStub("user-1"));

        // New order: Savings, Housing, Food.
        var result = await handler.Handle(
            new ReorderBudgetCategoriesCommand(s.MonthId, new[] { s.Savings, s.Housing, s.Food }),
            CancellationToken.None);

        result.Categories.Select(c => c.Name).Should().ContainInOrder("Savings", "Housing", "Food");
    }

    [Fact]
    public async Task Reorder_Throws_WhenACategoryIsNotInThisMonth()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetCategoriesCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new ReorderBudgetCategoriesCommand(s.MonthId, new[] { s.Housing, Guid.NewGuid() }),
                CancellationToken.None));
    }

    [Fact]
    public async Task Reorder_Throws_WhenUserDoesNotOwnTheMonth()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetCategoriesCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new ReorderBudgetCategoriesCommand(s.MonthId, new[] { s.Food, s.Housing, s.Savings }),
                CancellationToken.None));
    }

    [Fact]
    public async Task Reorder_KeepsIncomeGroupFirst_RegardlessOfOrder()
    {
        await using var db = NewContext();
        var income = new BudgetCategory { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 5 };
        var housing = new BudgetCategory { Name = "Housing", DisplayOrder = 0 };
        var month = new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6,
            Categories = new List<BudgetCategory> { income, housing },
        };
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();
        var handler = new ReorderBudgetCategoriesCommandHandler(db, new CurrentUserStub("user-1"));

        // Even if Housing is ordered before Income, Income still renders first.
        var result = await handler.Handle(
            new ReorderBudgetCategoriesCommand(month.Id, new[] { housing.Id, income.Id }),
            CancellationToken.None);

        result.Categories[0].Kind.Should().Be("Income");
    }
}
