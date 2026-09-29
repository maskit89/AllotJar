using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// TX-060.. — creating a transaction already split (the add-modal "Split across categories"
/// path): atomic parent+slices, same slice rules as the post-hoc split, and the
/// auto-categorizer must NOT add a whole-transaction line on top of slices.
/// </summary>
public class CreateTransactionWithSplitsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private sealed record Seeded(
        BudgetMonth Month, BudgetItem Groceries, BudgetItem Household, BudgetItem Salary);

    private static Seeded Seed(ApplicationDbContext db, string ownerId = "user-1")
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var household = new BudgetItem { Name = "Household", PlannedAmount = 100m };
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = 2000m };
        var month = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { salary } },
                new() { Name = "Food", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries, household } },
            },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return new Seeded(month, groceries, household, salary);
    }

    private static CreateTransactionCommand Command(
        IReadOnlyList<SplitAllocationInput>? splits,
        decimal amount = 100m,
        Guid? budgetItemId = null,
        Guid? memberId = null) =>
        new(new DateOnly(2026, 6, 5), "Supermarket", amount, TransactionType.Expense,
            budgetItemId, AccountId: null, MemberId: memberId, Splits: splits);

    [Fact]
    public async Task Create_WithSplits_PersistsSlices_AndLeavesWholeAssignmentNull()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);

        dto.IsSplit.Should().BeTrue();
        dto.BudgetItemId.Should().BeNull();
        dto.Splits.Should().HaveCount(2);
        dto.Splits.Select(x => x.Amount).Should().BeEquivalentTo(new[] { 70m, 30m });
        dto.Splits.Select(x => x.BudgetItemName).Should().BeEquivalentTo(new[] { "Groceries", "Household" });

        var reloaded = await db.Transactions.Include(t => t.Splits).SingleAsync();
        reloaded.BudgetItemId.Should().BeNull();
        reloaded.Splits.Should().HaveCount(2);
    }

    [Fact]
    public async Task Create_WithSplits_AttributesSlicesToMembers()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var alex = new HouseholdMember { OwnerId = "user-1", Name = "Alex" };
        var sam = new HouseholdMember { OwnerId = "user-1", Name = "Sam" };
        db.HouseholdMembers.AddRange(alex, sam);
        await db.SaveChangesAsync();
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 60m, alex.Id),
            new(s.Groceries.Id, 40m, sam.Id),
        }), CancellationToken.None);

        dto.Splits.Select(x => x.MemberName).Should().BeEquivalentTo(new[] { "Alex", "Sam" });
    }

    [Fact]
    public async Task Create_WithSplits_Throws_WhenSlicesDoNotSumToTotal()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 20m),
        }), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync()).Should().Be(0, "the create must be atomic — no torn parent row");
    }

    [Fact]
    public async Task Create_WithSplits_Throws_WhenLineKindDoesNotMatchDirection()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Salary.Id, 30m), // income line on an expense split
        }), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors["Splits"].Should().Contain(m => m.Contains("expense lines"));
    }

    [Fact]
    public async Task Create_WithSplits_Throws_WhenSliceLineOrMemberNotOwned()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var foreign = Seed(db, ownerId: "someone-else");
        var foreignMember = new HouseholdMember { OwnerId = "someone-else", Name = "Mallory" };
        db.HouseholdMembers.Add(foreignMember);
        await db.SaveChangesAsync();
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var lineAct = () => handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(foreign.Groceries.Id, 30m),
        }), CancellationToken.None);
        await lineAct.Should().ThrowAsync<ForbiddenAccessException>();

        var memberAct = () => handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m, foreignMember.Id),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);
        await memberAct.Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task Create_WithSplits_SkipsAutoCategorizer()
    {
        await using var db = NewContext();
        var s = Seed(db);
        // An earlier same-payee transaction assigned whole to Groceries — the categorizer's
        // trigger. With slices present it must NOT stamp a whole-transaction line.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 6, 1),
            Payee = "Supermarket",
            Amount = 55m,
            Type = TransactionType.Expense,
            BudgetItemId = s.Groceries.Id,
        });
        await db.SaveChangesAsync();
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);

        dto.BudgetItemId.Should().BeNull("slices are the assignment — a whole line too would double-count");
        dto.IsSplit.Should().BeTrue();
    }

    [Fact]
    public async Task Create_WithSplits_RollsUpIntoEachLineActual()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(Command(new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);

        var month = await db.BudgetMonths
            .Include(m => m.Categories).ThenInclude(c => c.Items)
            .SingleAsync(m => m.Id == s.Month.Id);
        await BudgetActuals.ApplyAsync(db, "user-1", month, CancellationToken.None);

        month.Categories.SelectMany(c => c.Items).Single(i => i.Name == "Groceries").ActualAmount.Should().Be(70m);
        month.Categories.SelectMany(c => c.Items).Single(i => i.Name == "Household").ActualAmount.Should().Be(30m);
    }
}
