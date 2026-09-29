using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// Proves a budget line's ActualAmount rolls up from the expense transactions
/// assigned to it, and only those — exercised through the budget query handler.
/// </summary>
public class BudgetActualsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-actuals-{Guid.NewGuid()}")
            .Options);

    [Fact]
    public async Task ActualAmount_SumsOnlyAssignedExpensesForTheOwner()
    {
        await using var db = NewContext();

        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 1100m };
        var month = new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Housing", Items = new List<BudgetItem> { rent } },
            },
        };
        db.BudgetMonths.Add(month);

        db.Transactions.AddRange(
            // counted: assigned expenses owned by user-1
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 300m, Type = TransactionType.Expense },
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 200m, Type = TransactionType.Expense },
            // ignored: income, unassigned, and another user's expense
            new Transaction { OwnerId = "user-1", BudgetItemId = rent.Id, Amount = 50m, Type = TransactionType.Income },
            new Transaction { OwnerId = "user-1", BudgetItemId = null, Amount = 100m, Type = TransactionType.Expense },
            new Transaction { OwnerId = "user-2", BudgetItemId = rent.Id, Amount = 500m, Type = TransactionType.Expense });
        await db.SaveChangesAsync();

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        var rentDto = dto.Categories[0].Items[0];
        rentDto.ActualAmount.Should().Be(500m); // 300 + 200 only
        rentDto.Remaining.Should().Be(600m); // 1100 planned - 500 actual
    }

    [Fact]
    public async Task ActualAmount_CountsTheConfirmedAmount_NotThePaidAbroadFigure()
    {
        await using var db = NewContext();

        var travel = new BudgetItem { Name = "Travel", PlannedAmount = 100m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Leisure", Items = new List<BudgetItem> { travel } },
            },
        });
        // Paid as 40 GBP; the user confirmed 46.00 EUR.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            BudgetItemId = travel.Id,
            Amount = 46m,
            Currency = CurrencyCode.Eur,
            OriginalAmount = 40m,
            OriginalCurrency = CurrencyCode.From("GBP"),
            Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var handler = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        dto.Categories[0].Items[0].ActualAmount.Should().Be(46.00m);
    }
}
