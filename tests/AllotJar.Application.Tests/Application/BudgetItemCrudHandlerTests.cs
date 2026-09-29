using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.DeleteBudgetItem;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Exercises the Add/Delete budget-line handlers (the new income-line primitives,
/// reused later for expense lines) against the EF Core in-memory provider:
/// adding/removing income moves the Remaining-to-Budget pool, expense lines only
/// move the assigned total, and a user can never mutate another user's budget.
/// </summary>
public class BudgetItemCrudHandlerTests
{
    private sealed class CurrentUserStub : ICurrentUser
    {
        public CurrentUserStub(string? userId) => UserId = userId;
        public string? UserId { get; }
    }

    private sealed record Seeded(Guid IncomeCategoryId, Guid ExpenseCategoryId, Guid IncomeLineId);

    // Income(Take-home Pay 3000) + Housing(Rent 1000) -> RemainingToBudget = 2000.
    private static Seeded Seed(ApplicationDbContext db, string ownerId)
    {
        var pay = new BudgetItem { Name = "Take-home Pay", PlannedAmount = 3000m };
        var income = new BudgetCategory
        {
            Name = "Income",
            Kind = CategoryKind.Income,
            DisplayOrder = 0,
            Items = new List<BudgetItem> { pay },
        };
        var housing = new BudgetCategory
        {
            Name = "Housing",
            DisplayOrder = 0,
            Items = new List<BudgetItem> { new() { Name = "Rent", PlannedAmount = 1000m } },
        };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory> { income, housing },
        });
        db.SaveChanges();
        return new Seeded(income.Id, housing.Id, pay.Id);
    }

    [Fact]
    public async Task Add_IncomeLine_RaisesTotalIncomeAndRemaining()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetItemCommand(s.IncomeCategoryId, "Freelance", 500m), CancellationToken.None);

        result.TotalIncome.Should().Be(3500m);
        result.TotalPlanned.Should().Be(1000m);        // expenses unchanged
        result.RemainingToBudget.Should().Be(2500m);   // 3500 - 1000
        result.Categories.First(c => c.Kind == "Income").Items
            .Should().Contain(i => i.Name == "Freelance" && i.PlannedAmount == 500m);
    }

    [Fact]
    public async Task Add_ExpenseLine_LowersRemainingOnly()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetItemCommand(s.ExpenseCategoryId, "Fuel", 120m), CancellationToken.None);

        result.TotalIncome.Should().Be(3000m);         // income unchanged
        result.TotalPlanned.Should().Be(1120m);        // 1000 + 120
        result.RemainingToBudget.Should().Be(1880m);
    }

    [Fact]
    public async Task Add_AssignsNextDisplayOrder()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetItemCommand(s.IncomeCategoryId, "Freelance"), CancellationToken.None);

        var freelance = result.Categories.First(c => c.Kind == "Income").Items.Single(i => i.Name == "Freelance");
        freelance.DisplayOrder.Should().Be(1); // after the seeded line at 0
        freelance.PlannedAmount.Should().Be(0m);
    }

    [Fact]
    public async Task Add_Throws_WhenUserDoesNotOwnTheCategory()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new AddBudgetItemCommand(s.IncomeCategoryId, "Sneaky", 1m), CancellationToken.None));
    }

    [Fact]
    public async Task Add_Throws_WhenCategoryDoesNotExist()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new AddBudgetItemCommand(Guid.NewGuid(), "Ghost", 1m), CancellationToken.None));
    }

    [Fact]
    public async Task Delete_IncomeLine_LowersTotalIncomeAndRemaining()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new DeleteBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new DeleteBudgetItemCommand(s.IncomeLineId), CancellationToken.None);

        result.TotalIncome.Should().Be(0m);
        result.RemainingToBudget.Should().Be(-1000m); // 0 income, 1000 planned -> over-budgeted
        result.Categories.First(c => c.Kind == "Income").Items.Should().BeEmpty();
    }

    [Fact]
    public async Task Delete_Throws_WhenUserDoesNotOwnTheItem()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new DeleteBudgetItemCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new DeleteBudgetItemCommand(s.IncomeLineId), CancellationToken.None));
    }

    [Fact]
    public async Task Delete_Throws_WhenItemDoesNotExist()
    {
        await using var db = NewContext();
        Seed(db, "user-1");
        var handler = new DeleteBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new DeleteBudgetItemCommand(Guid.NewGuid()), CancellationToken.None));
    }

    [Theory]
    [InlineData("", 0)]               // empty name
    [InlineData("Valid", -1)]         // negative planned
    public void Validator_Rejects_InvalidInput(string name, decimal planned)
    {
        var validator = new AddBudgetItemCommandValidator();
        var result = validator.Validate(new AddBudgetItemCommand(Guid.NewGuid(), name, planned));
        result.IsValid.Should().BeFalse();
    }

    [Fact]
    public void Validator_Rejects_NameLongerThan120()
    {
        var validator = new AddBudgetItemCommandValidator();
        var result = validator.Validate(
            new AddBudgetItemCommand(Guid.NewGuid(), new string('x', 121), 0m));
        result.IsValid.Should().BeFalse();
    }
}
