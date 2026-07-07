using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Exercises the UpdateBudgetItem command handler against the EF Core in-memory
/// provider, proving (a) the RemainingToBudget pool recomputes after an edit and
/// (b) a user cannot mutate another user's budget line.
/// </summary>
public class UpdateBudgetItemHandlerTests
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

    private static (Guid monthId, Guid itemId) Seed(ApplicationDbContext db, string ownerId)
    {
        var item = new BudgetItem { Name = "Rent", PlannedAmount = 1000m };
        var month = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income",
                    Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { Name = "Take-home Pay", PlannedAmount = 3000m } }
                },
                new()
                {
                    Name = "Housing",
                    Items = new List<BudgetItem> { item, new() { Name = "Utilities", PlannedAmount = 200m } }
                }
            }
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return (month.Id, item.Id);
    }

    [Fact]
    public async Task Handle_RecomputesRemainingToBudget_AfterEdit()
    {
        await using var db = NewContext();
        var (_, itemId) = Seed(db, "user-1");
        // Income 3000, planned 1000 + 200 = 1200 -> remaining 1800 before the edit.

        var handler = new UpdateBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new UpdateBudgetItemCommand(itemId, PlannedAmount: 1500m), CancellationToken.None);

        // Planned is now 1500 + 200 = 1700 -> remaining 1300.
        Assert.Equal(1700m, result.TotalPlanned);
        Assert.Equal(1300m, result.RemainingToBudget);
        Assert.False(result.IsBalanced);
    }

    [Fact]
    public async Task Handle_ReachesZero_WhenEveryEuroIsAssigned()
    {
        await using var db = NewContext();
        var (_, itemId) = Seed(db, "user-1");

        var handler = new UpdateBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        // Assign Rent = 2800 so total planned = 2800 + 200 = 3000 == income.
        var result = await handler.Handle(
            new UpdateBudgetItemCommand(itemId, PlannedAmount: 2800m), CancellationToken.None);

        Assert.Equal(0m, result.RemainingToBudget);
        Assert.True(result.IsBalanced);
    }

    [Fact]
    public async Task Handle_Throws_WhenUserDoesNotOwnTheItem()
    {
        await using var db = NewContext();
        var (_, itemId) = Seed(db, "user-1");

        // A different user tries to edit user-1's line.
        var handler = new UpdateBudgetItemCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(new UpdateBudgetItemCommand(itemId, 50m), CancellationToken.None));
    }

    [Fact]
    public async Task Handle_Throws_WhenItemDoesNotExist()
    {
        await using var db = NewContext();
        Seed(db, "user-1");

        var handler = new UpdateBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new UpdateBudgetItemCommand(Guid.NewGuid(), 50m), CancellationToken.None));
    }
}
