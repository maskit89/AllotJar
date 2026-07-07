using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonths;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Creating a month's budget — blank, or copied forward from the previous month —
/// and listing the months a user has.
/// </summary>
public class CreateBudgetMonthTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    // Seeds June 2026: Income(Pay 3000) + Housing(Rent 1000, spent 250 via a transaction) in GBP.
    private static void SeedJune(ApplicationDbContext db, string ownerId)
    {
        var june = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.From("GBP"),
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0,
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 3000m } },
                },
                new()
                {
                    Name = "Housing", DisplayOrder = 1,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Rent", PlannedAmount = 1000m },
                    },
                },
            },
        };
        db.BudgetMonths.Add(june);
        db.SaveChanges();

        // June's Rent has 250 spent — recorded as an assigned transaction, so we can
        // prove the copied July resets actuals (transactions don't carry over).
        var rent = june.Categories.Single(c => c.Name == "Housing").Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId, BudgetItemId = rent.Id, Amount = 250m, Type = TransactionType.Expense,
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task Create_CopiesStructureAndPlanned_FromPreviousMonth_ResettingActuals()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        july.Key.Should().Be("2026-07");
        july.BaseCurrency.Should().Be("GBP"); // inherited
        july.TotalIncome.Should().Be(3000m);  // planned copied
        var rent = july.Categories.Single(c => c.Name == "Housing").Items.Single(i => i.Name == "Rent");
        rent.PlannedAmount.Should().Be(1000m);
        rent.ActualAmount.Should().Be(0m);    // actuals reset
    }

    [Fact]
    public async Task Create_Blank_MakesAnEmptyIncomeGroupOnly()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        july.Categories.Should().ContainSingle();
        july.Categories[0].Kind.Should().Be("Income");
        july.Categories[0].Items.Should().BeEmpty();
        july.TotalIncome.Should().Be(0m);
    }

    [Fact]
    public async Task Create_CopyWithNoPriorMonth_FallsBackToBlank()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var june = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        june.Categories.Should().ContainSingle(c => c.Kind == "Income");
    }

    [Fact]
    public async Task Create_Throws_WhenMonthAlreadyExists()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new CreateBudgetMonthCommand(2026, 6), CancellationToken.None));
    }

    [Fact]
    public async Task Create_OnlyCopiesTheCallersOwnPreviousMonth()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1"); // belongs to user-1
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-2"));

        // user-2 has no prior month, so copy falls back to a blank budget.
        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        july.Categories.Should().ContainSingle(c => c.Kind == "Income");
        july.Categories.SelectMany(c => c.Items).Should().BeEmpty();
    }

    [Fact]
    public async Task GetMonths_ListsTheUsersMonths_NewestFirst()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var create = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        await create.Handle(new CreateBudgetMonthCommand(2026, 7), CancellationToken.None);

        var months = await new GetBudgetMonthsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthsQuery(), CancellationToken.None);

        months.Select(m => m.Key).Should().ContainInOrder("2026-07", "2026-06");
    }
}
