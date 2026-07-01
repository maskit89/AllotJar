using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.ReorderBudgetItems;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

public class ReorderBudgetItemsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    private sealed record Seeded(Guid CategoryId, Guid Rent, Guid Utilities, Guid Internet);

    // Housing with Rent(0), Utilities(1), Internet(2).
    private static Seeded Seed(ApplicationDbContext db, string ownerId)
    {
        var rent = new BudgetItem { Name = "Rent", DisplayOrder = 0 };
        var utilities = new BudgetItem { Name = "Utilities", DisplayOrder = 1 };
        var internet = new BudgetItem { Name = "Internet", DisplayOrder = 2 };
        var housing = new BudgetCategory
        {
            Name = "Housing",
            Items = new List<BudgetItem> { rent, utilities, internet },
        };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = 2026, Month = 6,
            Categories = new List<BudgetCategory> { housing },
        });
        db.SaveChanges();
        return new Seeded(housing.Id, rent.Id, utilities.Id, internet.Id);
    }

    [Fact]
    public async Task Reorder_SetsTheLineOrder()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetItemsCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new ReorderBudgetItemsCommand(s.CategoryId, new[] { s.Internet, s.Rent, s.Utilities }),
            CancellationToken.None);

        result.Categories.Single().Items.Select(i => i.Name)
            .Should().ContainInOrder("Internet", "Rent", "Utilities");
    }

    [Fact]
    public async Task Reorder_Throws_WhenALineIsNotInThisCategory()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetItemsCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(
                new ReorderBudgetItemsCommand(s.CategoryId, new[] { s.Rent, Guid.NewGuid() }),
                CancellationToken.None));
    }

    [Fact]
    public async Task Reorder_Throws_WhenUserDoesNotOwnTheCategory()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new ReorderBudgetItemsCommandHandler(db, new CurrentUserStub("attacker"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            handler.Handle(
                new ReorderBudgetItemsCommand(s.CategoryId, new[] { s.Utilities, s.Rent, s.Internet }),
                CancellationToken.None));
    }
}
