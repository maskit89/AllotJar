using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;
using AllotJar.Application.Tests.Imports;
using AllotJar.Application.Tests.TestDoubles;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// The auto-categorizer is now a quiet, zero-config fallback: a transaction logged
/// without a budget line inherits the line of the user's most recent earlier
/// transaction with the same description. There are no user-managed rules.
/// </summary>
public class AutoCategorizationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-autocat-{Guid.NewGuid()}")
            .Options);

    private static BudgetItem SeedMonthWithFood(ApplicationDbContext db, string ownerId, int year, int month)
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Items = new List<BudgetItem> { groceries } },
            },
        });
        db.SaveChanges();
        return groceries;
    }

    /// <summary>Seed a previously-categorized transaction (the thing future matches learn from).</summary>
    private static void SeedAssignedTransaction(
        ApplicationDbContext db, string ownerId, string payee, Guid budgetItemId, DateOnly date)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId,
            Payee = payee,
            BudgetItemId = budgetItemId,
            Date = date,
            Type = TransactionType.Expense,
        });
        db.SaveChanges();
    }

    // --- AutoCategorizer.ApplyAsync -----------------------------------------

    [Fact]
    public async Task Apply_InheritsLineFromMostRecentTransactionWithTheSameDescription()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var match = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };
        var noMatch = new Transaction { OwnerId = "user-1", Payee = "Unknown Shop", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { match, noMatch }, CancellationToken.None);

        count.Should().Be(1);
        match.BudgetItemId.Should().Be(groceries.Id);
        noMatch.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_DoesNotAssign_WhenNoPriorTransactionHasThatDescription()
    {
        await using var db = NewContext();
        SeedMonthWithFood(db, "user-1", 2026, 6);

        var tx = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { tx }, CancellationToken.None);

        count.Should().Be(0);
        tx.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_NeverInheritsAcrossOwners()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        // The only prior assigned transaction belongs to someone else.
        SeedAssignedTransaction(db, "user-2", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var tx = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { tx }, CancellationToken.None);

        count.Should().Be(0);
        tx.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_MatchesCaseAndWhitespaceInsensitively()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE  Markt", groceries.Id, new DateOnly(2026, 6, 1));

        var tx = new Transaction { OwnerId = "user-1", Payee = "  rewe markt ", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { tx }, CancellationToken.None);

        count.Should().Be(1);
        tx.BudgetItemId.Should().Be(groceries.Id);
    }

    [Fact]
    public async Task Apply_PrefersTheMostRecentMatchingLine()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        var dining = new BudgetItem { Name = "Dining Out", BudgetCategoryId = groceries.BudgetCategoryId };
        db.BudgetItems.Add(dining);
        await db.SaveChangesAsync();

        // Older assignment to Groceries, newer assignment to Dining Out — newer wins.
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));
        SeedAssignedTransaction(db, "user-1", "REWE", dining.Id, new DateOnly(2026, 6, 10));

        var tx = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 20), Type = TransactionType.Expense };

        await AutoCategorizer.ApplyAsync(db, "user-1", new[] { tx }, CancellationToken.None);

        tx.BudgetItemId.Should().Be(dining.Id);
    }

    // F4: a payee learned in one month resolves to the SAME line in the candidate's OWN month —
    // not the prior month's line. This is the fix for cross-month mis-bucketing after a rollover
    // (previously a July spend would inherit June's line id and land on June's actuals).
    [Fact]
    public async Task Apply_ResolvesToTheSameLineInTheCandidatesOwnMonth_NotThePriorMonth()
    {
        await using var db = NewContext();
        var juneGroceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        var julyGroceries = SeedMonthWithFood(db, "user-1", 2026, 7);
        // Learned from June: REWE -> June's Groceries.
        SeedAssignedTransaction(db, "user-1", "REWE", juneGroceries.Id, new DateOnly(2026, 6, 1));

        var july = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 7, 3), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { july }, CancellationToken.None);

        count.Should().Be(1);
        july.BudgetItemId.Should().Be(julyGroceries.Id);   // July's line…
        july.BudgetItemId.Should().NotBe(juneGroceries.Id); // …never June's
    }

    // If the candidate's month has no matching line, the payee is left unassigned rather than
    // borrowing another month's line.
    [Fact]
    public async Task Apply_LeavesUnassigned_WhenTheCandidatesMonthHasNoMatchingLine()
    {
        await using var db = NewContext();
        var juneGroceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        // July exists but with no Groceries line.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Items = new List<BudgetItem> { new() { Name = "Dining Out" } } },
            },
        });
        await db.SaveChangesAsync();
        SeedAssignedTransaction(db, "user-1", "REWE", juneGroceries.Id, new DateOnly(2026, 6, 1));

        var july = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 7, 3), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { july }, CancellationToken.None);

        count.Should().Be(0);
        july.BudgetItemId.Should().BeNull();
    }

    // --- Manual create integration ------------------------------------------

    [Fact]
    public async Task CreateTransaction_WithoutALine_InheritsFromTheMostRecentSameDescription()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 12), "REWE", 42.10m, TransactionType.Expense, BudgetItemId: null),
            CancellationToken.None);

        dto.BudgetItemId.Should().Be(groceries.Id);
        dto.BudgetItemName.Should().Be("Groceries"); // navigation hydrated for the response
    }

    [Fact]
    public async Task CreateTransaction_RespectsAnExplicitlyChosenLine_OverTheFallback()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        var dining = new BudgetItem { Name = "Dining Out", BudgetCategoryId = groceries.BudgetCategoryId };
        db.BudgetItems.Add(dining);
        await db.SaveChangesAsync();
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new CreateTransactionCommand(new DateOnly(2026, 6, 12), "REWE", 42.10m, TransactionType.Expense, BudgetItemId: dining.Id),
            CancellationToken.None);

        dto.BudgetItemId.Should().Be(dining.Id); // explicit choice wins
    }

    // --- Direction- and date-awareness (2026-07-22 re-review F4) ------------------------

    [Fact]
    public async Task Apply_ARefund_NeverInheritsTheMerchantsExpenseLine()
    {
        // The purchases taught "REWE" -> Groceries (an expense line). A refund from the same
        // merchant is INCOME — inheriting the expense line would subtract it from meaningful
        // actuals instead of counting it anywhere.
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var refund = new Transaction
        {
            OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 10),
            Type = TransactionType.Income,
        };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { refund }, CancellationToken.None);

        count.Should().Be(0);
        refund.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_ABackdatedTransaction_NeverLearnsFromTheFuture()
    {
        // The only "REWE" history is dated AFTER the backdated candidate — nothing prior
        // exists, so nothing is inherited. (The old behavior keyed learning on "most recent
        // overall", letting later data leak backwards in time.)
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 20));

        var backdated = new Transaction
        {
            OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 5),
            Type = TransactionType.Expense,
        };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { backdated }, CancellationToken.None);

        count.Should().Be(0);
        backdated.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_CandidatesWithDifferentDates_ResolveIndependently()
    {
        // Same payee, one candidate before the learned history and one after: only the later
        // one has a prior to inherit from.
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 10));

        var before = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 5), Type = TransactionType.Expense };
        var after = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 15), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { before, after }, CancellationToken.None);

        count.Should().Be(1);
        before.BudgetItemId.Should().BeNull();
        after.BudgetItemId.Should().Be(groceries.Id);
    }

    [Fact]
    public async Task Apply_LegacyMiscategorizedHistory_DoesNotPropagate()
    {
        // A pre-invariant row: INCOME assigned to an EXPENSE line. It must teach nothing —
        // neither a new income (same direction, incompatible line kind) nor a new expense
        // (compatible line, different direction).
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "REWE", BudgetItemId = groceries.Id,
            Date = new DateOnly(2026, 6, 1), Type = TransactionType.Income, // the legacy mistake
        });
        await db.SaveChangesAsync();

        var income = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 10), Type = TransactionType.Income };
        var expense = new Transaction { OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 10), Type = TransactionType.Expense };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { income, expense }, CancellationToken.None);

        count.Should().Be(0);
        income.BudgetItemId.Should().BeNull();
        expense.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Apply_ATransfer_IsNeverACandidate()
    {
        await using var db = NewContext();
        var groceries = SeedMonthWithFood(db, "user-1", 2026, 6);
        SeedAssignedTransaction(db, "user-1", "REWE", groceries.Id, new DateOnly(2026, 6, 1));

        var transfer = new Transaction
        {
            OwnerId = "user-1", Payee = "REWE", Date = new DateOnly(2026, 6, 10),
            Type = TransactionType.Transfer,
        };

        var count = await AutoCategorizer.ApplyAsync(db, "user-1", new[] { transfer }, CancellationToken.None);

        count.Should().Be(0);
        transfer.BudgetItemId.Should().BeNull();
    }
}
