using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

public class TransactionHandlersTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-tx-{Guid.NewGuid()}")
            .Options);

    private static BudgetItem SeedMonthWithItem(ApplicationDbContext db, string ownerId)
    {
        var item = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Items = new List<BudgetItem> { item } },
            },
        });
        db.SaveChanges();
        return item;
    }

    private static Transaction SeedTransaction(ApplicationDbContext db, string ownerId, bool assigned = false, Guid? itemId = null)
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            Amount = 25m,
            Type = TransactionType.Expense,
            Payee = "Supermarket",
            BudgetItemId = assigned ? itemId : null,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    // --- AssignTransaction ---------------------------------------------------

    [Fact]
    public async Task Assign_LinksTransactionToLine()
    {
        await using var db = NewContext();
        var item = SeedMonthWithItem(db, "user-1");
        var tx = SeedTransaction(db, "user-1");

        var handler = new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new AssignTransactionCommand(tx.Id, item.Id), CancellationToken.None);

        dto.BudgetItemId.Should().Be(item.Id);
        dto.BudgetItemName.Should().Be("Groceries");
        (await db.Transactions.FindAsync(tx.Id))!.BudgetItemId.Should().Be(item.Id);
    }

    [Fact]
    public async Task Assign_WithNull_ClearsAssignment()
    {
        await using var db = NewContext();
        var item = SeedMonthWithItem(db, "user-1");
        var tx = SeedTransaction(db, "user-1", assigned: true, itemId: item.Id);

        var handler = new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new AssignTransactionCommand(tx.Id, null), CancellationToken.None);

        dto.BudgetItemId.Should().BeNull();
        dto.BudgetItemName.Should().BeNull();
    }

    [Fact]
    public async Task Assign_ToAnotherUsersTransaction_Throws()
    {
        await using var db = NewContext();
        var item = SeedMonthWithItem(db, "user-1");
        var tx = SeedTransaction(db, "user-1");

        var handler = new AssignTransactionCommandHandler(db, new CurrentUserStub("attacker"));
        var act = () => handler.Handle(new AssignTransactionCommand(tx.Id, item.Id), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Assign_ToAnotherUsersLine_Throws()
    {
        await using var db = NewContext();
        var otherItem = SeedMonthWithItem(db, "user-2");
        var tx = SeedTransaction(db, "user-1");

        var handler = new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var act = () => handler.Handle(new AssignTransactionCommand(tx.Id, otherItem.Id), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    // --- GetTransactions -----------------------------------------------------

    [Fact]
    public async Task Get_ReturnsOnlyTheCurrentUsersTransactions()
    {
        await using var db = NewContext();
        SeedTransaction(db, "user-1");
        SeedTransaction(db, "user-1");
        SeedTransaction(db, "user-2");

        var handler = new GetTransactionsQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetTransactionsQuery(), CancellationToken.None);

        result.Should().HaveCount(2);
        result.Should().OnlyContain(t => t.Payee == "Supermarket");
    }

    [Fact]
    public async Task Get_UnassignedOnly_FiltersAssigned()
    {
        await using var db = NewContext();
        var item = SeedMonthWithItem(db, "user-1");
        SeedTransaction(db, "user-1", assigned: true, itemId: item.Id);
        SeedTransaction(db, "user-1"); // unassigned

        var handler = new GetTransactionsQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetTransactionsQuery(UnassignedOnly: true), CancellationToken.None);

        result.Should().ContainSingle().Which.BudgetItemId.Should().BeNull();
    }
}
