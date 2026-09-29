using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Transactions;

public class SplitTransactionTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private sealed record Seeded(
        BudgetMonth Month, BudgetItem Groceries, BudgetItem Household, BudgetItem Salary);

    /// <summary>One month, owner "user-1": expense lines Groceries/Household + income line Salary.</summary>
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

    private static Transaction SeedExpense(ApplicationDbContext db, decimal amount, string ownerId = "user-1")
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            Date = new DateOnly(2026, 6, 5),
            Payee = "Supermarket",
            Amount = amount,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    [Fact]
    public async Task Split_AllocatesAcrossLines_ClearsWholeAssignment_AndTracksLines()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        tx.BudgetItemId = s.Groceries.Id; // starts assigned whole
        await db.SaveChangesAsync();

        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(s.Groceries.Id, 70m),
                new(s.Household.Id, 30m),
            }),
            CancellationToken.None);

        dto.IsSplit.Should().BeTrue();
        dto.BudgetItemId.Should().BeNull();
        dto.Splits.Should().HaveCount(2);
        dto.Splits.Select(x => x.Amount).Should().BeEquivalentTo(new[] { 70m, 30m });
        dto.Splits.Select(x => x.BudgetItemName).Should().BeEquivalentTo(new[] { "Groceries", "Household" });

        var reloaded = await db.Transactions.Include(t => t.Splits).FirstAsync(t => t.Id == tx.Id);
        reloaded.BudgetItemId.Should().BeNull();
        reloaded.Splits.Should().HaveCount(2);
    }

    [Fact]
    public async Task Split_AttributesSlicesToMembers()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var alex = new HouseholdMember { OwnerId = "user-1", Name = "Alex" };
        var sam = new HouseholdMember { OwnerId = "user-1", Name = "Sam" };
        db.HouseholdMembers.AddRange(alex, sam);
        await db.SaveChangesAsync();
        var tx = SeedExpense(db, 100m);

        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        // A shared purchase on one budget line, divided across two people (the Visa case).
        var dto = await handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 60m, alex.Id),
            new(s.Groceries.Id, 40m, sam.Id),
        }), CancellationToken.None);

        dto.Splits.Should().HaveCount(2);
        dto.Splits.Select(x => x.MemberName).Should().BeEquivalentTo(new[] { "Alex", "Sam" });
        dto.Splits.Single(x => x.MemberName == "Alex").Amount.Should().Be(60m);
        dto.Splits.Single(x => x.MemberName == "Sam").Amount.Should().Be(40m);
    }

    [Fact]
    public async Task Split_Throws_WhenSliceMemberNotOwned()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var stranger = new HouseholdMember { OwnerId = "user-2", Name = "Stranger" };
        db.HouseholdMembers.Add(stranger);
        await db.SaveChangesAsync();
        var tx = SeedExpense(db, 100m);

        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var act = () => handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 60m, stranger.Id), // another user's member
            new(s.Household.Id, 40m),
        }), CancellationToken.None);

        await act.Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task Split_RollsUpIntoEachLineActual()
    {
        await using var db = NewContext();
        var s = Seed(db);
        // Lines must be Tracked for the roll-up to show — the split sets this, but
        // assert end-to-end through the budget query.
        var tx = SeedExpense(db, 100m);

        var splitHandler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        await splitHandler.Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(s.Groceries.Id, 70m),
                new(s.Household.Id, 30m),
            }),
            CancellationToken.None);

        var budget = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await budget.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);

        var food = dto.Categories.Single(c => c.Name == "Food");
        food.Items.Single(i => i.Name == "Groceries").ActualAmount.Should().Be(70m);
        food.Items.Single(i => i.Name == "Household").ActualAmount.Should().Be(30m);
    }

    [Fact]
    public async Task Split_AddsToWholeTransactionsOnTheSameLine()
    {
        await using var db = NewContext();
        var s = Seed(db);

        // A whole transaction on Groceries...
        var whole = SeedExpense(db, 20m);
        whole.BudgetItemId = s.Groceries.Id;
        await db.SaveChangesAsync();

        // ...plus a split that also lands 70 on Groceries.
        var tx = SeedExpense(db, 100m);
        await new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1")).Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(s.Groceries.Id, 70m),
                new(s.Household.Id, 30m),
            }),
            CancellationToken.None);

        var budget = new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"));
        var dto = await budget.Handle(new GetBudgetMonthQuery(2026, 6), CancellationToken.None);
        var food = dto.Categories.Single(c => c.Name == "Food");
        food.Items.Single(i => i.Name == "Groceries").ActualAmount.Should().Be(90m); // 20 whole + 70 split
    }

    [Fact]
    public async Task Split_ReplacesAnExistingSplit()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 60m),
            new(s.Household.Id, 40m),
        }), CancellationToken.None);

        var dto = await handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 80m),
            new(s.Household.Id, 20m),
        }), CancellationToken.None);

        dto.Splits.Should().HaveCount(2);
        dto.Splits.Select(x => x.Amount).Should().BeEquivalentTo(new[] { 80m, 20m });
        (await db.TransactionSplits.CountAsync(x => x.TransactionId == tx.Id)).Should().Be(2);
    }

    [Fact]
    public async Task Split_Throws_WhenSlicesDoNotSumToTotal()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 20m), // 90 != 100
        }), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task Split_Throws_WhenLineKindDoesNotMatchTransaction()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        // Splitting an expense onto the income line is rejected.
        var act = () => handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Salary.Id, 30m),
        }), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task Split_Throws_WhenTransactionNotOwned()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("attacker"));

        var act = () => handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Split_Throws_WhenTargetLineNotOwned()
    {
        await using var db = NewContext();
        var mine = Seed(db, "user-1");
        var theirs = Seed(db, "user-2");
        var tx = SeedExpense(db, 100m, "user-1");
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(mine.Groceries.Id, 70m),
            new(theirs.Household.Id, 30m), // another user's line
        }), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public void Validator_Rejects_FewerThanTwoAllocations()
    {
        var validator = new SplitTransactionCommandValidator();
        validator.Validate(new SplitTransactionCommand(Guid.NewGuid(), new List<SplitAllocationInput>
        {
            new(Guid.NewGuid(), 100m),
        })).IsValid.Should().BeFalse();
    }

    [Fact]
    public void Validator_Rejects_NonPositiveSliceAmount()
    {
        var validator = new SplitTransactionCommandValidator();
        validator.Validate(new SplitTransactionCommand(Guid.NewGuid(), new List<SplitAllocationInput>
        {
            new(Guid.NewGuid(), 100m),
            new(Guid.NewGuid(), 0m),
        })).IsValid.Should().BeFalse();
    }

    [Fact]
    public async Task Assign_ClearsAnExistingSplit()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var tx = SeedExpense(db, 100m);
        await new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1")).Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(s.Groceries.Id, 70m),
                new(s.Household.Id, 30m),
            }),
            CancellationToken.None);

        var assign = new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await assign.Handle(new AssignTransactionCommand(tx.Id, s.Groceries.Id), CancellationToken.None);

        dto.IsSplit.Should().BeFalse();
        dto.BudgetItemId.Should().Be(s.Groceries.Id);
        (await db.TransactionSplits.CountAsync(x => x.TransactionId == tx.Id)).Should().Be(0);
    }

    private static Account SeedAccount(ApplicationDbContext db, string name = "Joint", string ownerId = "user-1")
    {
        var account = new Account { OwnerId = ownerId, Name = name };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    // The split response DTO must carry the account name — the handler re-reads the saved
    // transaction with .Include(t => t.Account), so accountName is populated (not null).
    [Fact]
    public async Task Split_Response_CarriesAccountName()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var account = SeedAccount(db);
        var tx = SeedExpense(db, 100m);
        tx.AccountId = account.Id;
        await db.SaveChangesAsync();

        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        }), CancellationToken.None);

        dto.AccountId.Should().Be(account.Id);
        dto.AccountName.Should().Be("Joint");
    }

    // The assign response DTO must carry the account name — the handler loads the transaction with
    // .Include(t => t.Account), so accountName is populated (not null).
    [Fact]
    public async Task Assign_Response_CarriesAccountName()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var account = SeedAccount(db);
        var tx = SeedExpense(db, 100m);
        tx.AccountId = account.Id;
        await db.SaveChangesAsync();

        var handler = new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new AssignTransactionCommand(tx.Id, s.Groceries.Id), CancellationToken.None);

        dto.AccountId.Should().Be(account.Id);
        dto.AccountName.Should().Be("Joint");
    }

    // --- Split invariant completion (2026-07-22 re-review F2): transfers can't split,
    // slices are month-coherent, and the whole-member attribution clears with the line. ---

    [Fact]
    public async Task Split_RejectsATransfer()
    {
        // A transfer never carries budget attribution; splitting one across expense lines
        // used to slip through because the direction check treated Transfer as an expense.
        await using var db = NewContext();
        var s = Seed(db);
        var transfer = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 5), Payee = "Transfer",
            Amount = 100m, Type = TransactionType.Transfer,
        };
        db.Transactions.Add(transfer);
        await db.SaveChangesAsync();
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(
                new SplitTransactionCommand(transfer.Id, new List<SplitAllocationInput>
                {
                    new(s.Groceries.Id, 70m),
                    new(s.Household.Id, 30m),
                }),
                CancellationToken.None));

        ex.Errors["Allocations"].Single().Should().Contain("transfer");
        (await db.TransactionSplits.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Split_CrossMonthSlices_NeedTheAcknowledgment()
    {
        // The transaction is dated July; the slice lines live in June. Without the
        // acknowledgment the split is rejected under the crossMonth key; with it, allowed —
        // the same rule a whole assignment follows.
        await using var db = NewContext();
        var s = Seed(db); // June lines
        var tx = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 7, 2), Payee = "Supermarket",
            Amount = 100m, Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));
        var allocations = new List<SplitAllocationInput>
        {
            new(s.Groceries.Id, 70m),
            new(s.Household.Id, 30m),
        };

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new SplitTransactionCommand(tx.Id, allocations), CancellationToken.None));
        ex.Errors.Should().ContainKey("crossMonth");

        var dto = await handler.Handle(
            new SplitTransactionCommand(tx.Id, allocations, AcknowledgeCrossMonth: true),
            CancellationToken.None);
        dto.IsSplit.Should().BeTrue();
    }

    [Fact]
    public async Task Split_ClearsTheWholeMemberAttribution_SoUnsplittingCannotResurrectIt()
    {
        // Splitting used to clear only BudgetItemId. The stale whole-member survived
        // invisibly and reappeared as live attribution when the split was later removed
        // (unsplit via AssignTransaction).
        await using var db = NewContext();
        var s = Seed(db);
        var member = new HouseholdMember { OwnerId = "user-1", Name = "Alex" };
        db.HouseholdMembers.Add(member);
        var tx = SeedExpense(db, 100m);
        tx.MemberId = member.Id;
        await db.SaveChangesAsync();
        var handler = new SplitTransactionCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(s.Groceries.Id, 70m),
                new(s.Household.Id, 30m),
            }),
            CancellationToken.None);

        (await db.Transactions.SingleAsync(t => t.Id == tx.Id)).MemberId.Should().BeNull();

        // Unsplit (whole re-assignment removes the slices): no member attribution comes back.
        await new AssignTransactionCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new AssignTransactionCommand(tx.Id, s.Groceries.Id), CancellationToken.None);

        var reloaded = await db.Transactions.Include(t => t.Splits).SingleAsync(t => t.Id == tx.Id);
        reloaded.Splits.Should().BeEmpty();
        reloaded.MemberId.Should().BeNull();
        reloaded.BudgetItemId.Should().Be(s.Groceries.Id);
    }
}
