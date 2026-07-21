using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Transactions coverage (catalog prefix TX, file docs/testing/cases/10-transactions.md).
/// Automates the highest-value P0/P1 (plus a couple of cheap P2) cases whose behaviour
/// lives at the Application/domain layer and was previously "No"/"Partial":
/// whole-transaction reassignment moving a line's actual (TX-031/032); the assign
/// endpoint's deliberate lack of kind/type checking and the "shows but never lands"
/// consequence in actuals (TX-034/035/085); the split editor's kind rules where a
/// Savings line counts as expense-side (TX-052); the known coherence edge where editing
/// a split parent's amount leaves the slices stale (TX-067); delete restoring both the
/// derived line actual and the account balance, including the single-row transfer
/// (TX-068/071); the ExcludeFromAllocation flag having no transaction-side effect
/// (TX-095); the server amount-range validator (TX-026); and the server-side
/// unassignedOnly filter counting transfers and split parents as unassigned (TX-076).
///
/// Pure client-render / optimistic-UI / modal-wiring cases (hero totals, remainder chip,
/// disabled Save button, picker blur, empty states) are deferred to the Vitest layer;
/// FK-cascade behaviour (deleting a split cascades its slices, deleted-line SetNull) is
/// deferred to the SQL integration layer because EF InMemory does not enforce FKs.
///
/// The canonical fixture from the catalog (§ Test data setup) is rebuilt in
/// <see cref="SeedMonth"/>: a EUR July-2026 month with an Income line (Salary), two
/// Expense lines (Groceries, and Internet with DueDay 20), and a Savings line (Emergency).
/// </summary>
public class TTransactionsCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-tx-cov-{Guid.NewGuid()}")
            .Options);

    private sealed record Fixture(Guid SalaryId, Guid GroceriesId, Guid InternetId, Guid EmergencyId);

    /// <summary>EUR July-2026 month for <paramref name="ownerId"/>: Income(Salary),
    /// Expense(Groceries, Internet), Savings(Emergency). Returns the line ids.</summary>
    private static Fixture SeedMonth(ApplicationDbContext db, string ownerId = "user-1")
    {
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = 2500m, DisplayOrder = 0 };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m, DisplayOrder = 0 };
        var internet = new BudgetItem { Name = "Internet", PlannedAmount = 50m, DueDay = 20, DisplayOrder = 1 };
        var emergency = new BudgetItem { Name = "Emergency", PlannedAmount = 100m, SavingsId = Guid.NewGuid(), DisplayOrder = 0 };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { salary } },
                new() { Name = "Everyday", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = new List<BudgetItem> { groceries, internet } },
                new() { Name = "Emergency", Kind = CategoryKind.Savings, DisplayOrder = 2, Items = new List<BudgetItem> { emergency } },
            },
        });
        db.SaveChanges();
        return new Fixture(salary.Id, groceries.Id, internet.Id, emergency.Id);
    }

    private static Account SeedAccount(ApplicationDbContext db, string name, decimal opening, string ownerId = "user-1")
    {
        var a = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = AccountType.Current,
            Currency = CurrencyCode.Eur,
            OpeningBalance = opening,
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static async Task<decimal> ActualOf(ApplicationDbContext db, ICurrentUser user, Guid itemId)
    {
        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        return month.Categories.SelectMany(c => c.Items).Single(i => i.Id == itemId).ActualAmount;
    }

    private static async Task<decimal> BalanceOf(ApplicationDbContext db, ICurrentUser user, Guid accountId)
    {
        var accounts = await new GetAccountsQueryHandler(db, user)
            .Handle(new GetAccountsQuery(), CancellationToken.None);
        return accounts.Single(a => a.Id == accountId).CurrentBalance;
    }

    // --- Whole-transaction (re)assignment and its effect on actuals ----------

    // TX-031: reassigning a whole transaction moves its amount off the old line onto the new.
    [Fact]
    public async Task Reassign_MovesTheActual_FromOldLineToNewLine()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Tesco",
            Amount = 40m,
            Type = TransactionType.Expense,
            BudgetItemId = f.GroceriesId,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        (await ActualOf(db, user, f.GroceriesId)).Should().Be(40m);

        await new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(tx.Id, f.InternetId), CancellationToken.None);

        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
        (await ActualOf(db, user, f.InternetId)).Should().Be(40m);
    }

    // TX-032: clearing the assignment (budgetItemId = null) drops the line's actual back to zero.
    [Fact]
    public async Task ClearingAssignment_DropsTheLineActualToZero()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Tesco",
            Amount = 40m,
            Type = TransactionType.Expense,
            BudgetItemId = f.GroceriesId,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        var dto = await new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(tx.Id, null), CancellationToken.None);

        dto.BudgetItemId.Should().BeNull();
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
    }

    // TX-034: the assign endpoint enforces direction/kind — an income transaction cannot be
    // assigned to an expense line. (Previously this silently succeeded, producing a "shows but
    // never lands" row; closed by the transaction-invariant guard.)
    [Fact]
    public async Task Assign_IncomeTransactionToExpenseLine_IsRejected()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var income = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Bonus",
            Amount = 100m,
            Type = TransactionType.Income,
        };
        db.Transactions.Add(income);
        await db.SaveChangesAsync();

        var act = () => new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(income.Id, f.GroceriesId), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
        // The income never landed on the expense line.
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
    }

    // TX-036: assigning a transaction to a line in a DIFFERENT month than its date is rejected
    // (under the cross-month key) unless the request acknowledges it — the deliberate "purchase
    // dated last month, budget it to this month's line" case (e.g. an end-of-month clearing).
    [Fact]
    public async Task Assign_ToALineInADifferentMonth_IsRejected_UnlessAcknowledged()
    {
        await using var db = NewContext();
        var f = SeedMonth(db); // July 2026 lines
        var user = new CurrentUserStub("user-1");

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 6, 20), // June — a month before the July line
            Payee = "Tesco",
            Amount = 40m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        // Without acknowledgement: rejected, flagged under the cross-month key.
        var act = () => new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(tx.Id, f.GroceriesId), CancellationToken.None);
        var ex = (await act.Should().ThrowAsync<ValidationException>()).Which;
        ex.Errors.Should().ContainKey(TransactionInvariants.CrossMonthKey);
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);

        // With acknowledgement: it lands, budgeted to the July line.
        await new AssignTransactionCommandHandler(db, user)
            .Handle(new AssignTransactionCommand(tx.Id, f.GroceriesId, AcknowledgeCrossMonth: true), CancellationToken.None);
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(40m);
    }

    // TX-037: a transaction can't be attached to an account whose currency differs from the
    // transaction's — account balances sum raw amounts, so a EUR entry on a GBP account would
    // corrupt the GBP balance (F6).
    [Fact]
    public async Task Create_OnAnAccountOfADifferentCurrency_IsRejected()
    {
        await using var db = NewContext();
        SeedMonth(db); // EUR July 2026 month — a manual entry is stamped EUR
        var user = new CurrentUserStub("user-1");

        var gbpAccount = new Account
        {
            OwnerId = "user-1",
            Name = "GBP Pot",
            Currency = CurrencyCode.From("GBP"),
            OpeningBalance = 0m,
        };
        db.Accounts.Add(gbpAccount);
        await db.SaveChangesAsync();

        var act = () => new CreateTransactionCommandHandler(db, user).Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 7, 10), "Tesco", 40m, TransactionType.Expense, BudgetItemId: null, AccountId: gbpAccount.Id),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // TX-035: a mismatched whole-assignment "shows but never lands" — an income transaction
    // force-assigned to the Groceries expense line contributes 0 to that line's actual, because
    // actuals group by (BudgetItemId, Type) and an expense line only reads Expense transactions.
    [Fact]
    public async Task MismatchedWholeAssignment_ContributesZeroToActuals()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Bonus",
            Amount = 100m,
            Type = TransactionType.Income,
            BudgetItemId = f.GroceriesId, // income money pinned onto an expense line
        });
        await db.SaveChangesAsync();

        // The expense line's spent stays 0 (income never lands on an expense line)...
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
        // ...and the Salary income line is untouched too — the money simply never lands anywhere.
        (await ActualOf(db, user, f.SalaryId)).Should().Be(0m);
    }

    // TX-085: a transfer force-assigned to a budget line likewise contributes 0 to actuals —
    // transfers are excluded from the budget entirely, even when they carry a BudgetItemId.
    [Fact]
    public async Task TransferForceAssignedToALine_ContributesZeroToActuals()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Transfer",
            Amount = 500m,
            Type = TransactionType.Transfer,
            BudgetItemId = f.GroceriesId, // crafted: a transfer pinned onto an expense line
        });
        await db.SaveChangesAsync();

        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
    }

    // --- Split kind rules (Savings counts as expense-side) -------------------

    // TX-052: an expense may be split across a Savings line (a savings line is drawn down by an
    // expense), and each slice rolls into its target line's actual. Stricter than the whole-tx
    // assign picker, which is unfiltered.
    [Fact]
    public async Task Split_ExpenseAcrossASavingsLine_IsAllowed_AndRollsUp()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Costco",
            Amount = 100m,
            Type = TransactionType.Expense,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        var dto = await new SplitTransactionCommandHandler(db, user).Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(f.GroceriesId, 70m),
                new(f.EmergencyId, 30m), // Savings line — allowed on the expense side
            }),
            CancellationToken.None);

        dto.IsSplit.Should().BeTrue();
        dto.Splits.Should().HaveCount(2);
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(70m);
        (await ActualOf(db, user, f.EmergencyId)).Should().Be(30m);
    }

    // TX-052 (mirror): income may NOT be split into a Savings line — savings counts as
    // non-income, so the kind check rejects it ("Income can only be split across income lines.").
    [Fact]
    public async Task Split_IncomeAcrossASavingsLine_IsRejected()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var income = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Payday",
            Amount = 100m,
            Type = TransactionType.Income,
        };
        db.Transactions.Add(income);
        await db.SaveChangesAsync();

        var act = () => new SplitTransactionCommandHandler(db, user).Handle(
            new SplitTransactionCommand(income.Id, new List<SplitAllocationInput>
            {
                new(f.SalaryId, 70m),
                new(f.EmergencyId, 30m), // Savings line — not income
            }),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
    }

    // --- Split-parent edit coherence edge ------------------------------------

    // TX-067: editing a split parent's amount is REJECTED — the slices carry the attribution and
    // must keep summing to the whole, so the generic update refuses an amount change on a split
    // transaction (the caller re-splits instead). Closes the stale-slice coherence hole.
    [Fact]
    public async Task EditingASplitParentsAmount_IsRejected_AndLeavesEverythingCoherent()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");
        var joint = SeedAccount(db, "Joint", 1000m);

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Costco",
            Amount = 100m,
            Type = TransactionType.Expense,
            AccountId = joint.Id,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        await new SplitTransactionCommandHandler(db, user).Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(f.GroceriesId, 70m),
                new(f.InternetId, 30m),
            }),
            CancellationToken.None);

        // Changing the amount of a split transaction via the generic update is rejected.
        var act = () => new UpdateTransactionCommandHandler(db, user).Handle(
            new UpdateTransactionCommand(
                tx.Id, new DateOnly(2026, 7, 10), "Costco", 120m, TransactionType.Expense, joint.Id),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();

        // Nothing moved: parent, slices, derived actuals and balance all stay coherent.
        var reloaded = await db.Transactions.Include(t => t.Splits).FirstAsync(t => t.Id == tx.Id);
        reloaded.Amount.Should().Be(100m);
        reloaded.Splits.Sum(s => s.Amount).Should().Be(100m);
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(70m);
        (await ActualOf(db, user, f.InternetId)).Should().Be(30m);
        (await BalanceOf(db, user, joint.Id)).Should().Be(900m); // 1000 − 100, unchanged
    }

    // TX-034b: creating an income transaction directly on an expense line is rejected too — the
    // whole-line kind guard applies at creation, not only on the assign endpoint.
    [Fact]
    public async Task Create_IncomeTransactionOnAnExpenseLine_IsRejected()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        var act = () => new CreateTransactionCommandHandler(db, user).Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 7, 10), "Bonus", 100m, TransactionType.Income, f.GroceriesId),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
    }

    // TX-067b: editing only the non-amount fields of a split (payee, date) is still allowed — the
    // guard blocks amount/type/member edits, not everything, so ordinary corrections keep working.
    [Fact]
    public async Task Update_NonAmountFieldsOfASplit_AreAllowed()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");
        var joint = SeedAccount(db, "Joint", 1000m);

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Costco",
            Amount = 100m,
            Type = TransactionType.Expense,
            AccountId = joint.Id,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        await new SplitTransactionCommandHandler(db, user).Handle(
            new SplitTransactionCommand(tx.Id, new List<SplitAllocationInput>
            {
                new(f.GroceriesId, 70m),
                new(f.InternetId, 30m),
            }),
            CancellationToken.None);

        // Same amount/type, just a corrected payee and date — allowed.
        await new UpdateTransactionCommandHandler(db, user).Handle(
            new UpdateTransactionCommand(
                tx.Id, new DateOnly(2026, 7, 12), "Costco Wholesale", 100m, TransactionType.Expense, joint.Id),
            CancellationToken.None);

        var reloaded = await db.Transactions.Include(t => t.Splits).FirstAsync(t => t.Id == tx.Id);
        reloaded.Payee.Should().Be("Costco Wholesale");
        reloaded.Date.Should().Be(new DateOnly(2026, 7, 12));
        reloaded.Splits.Sum(s => s.Amount).Should().Be(100m);
        (await ActualOf(db, user, f.GroceriesId)).Should().Be(70m);
        (await ActualOf(db, user, f.InternetId)).Should().Be(30m);
    }

    // --- Delete effects on derived actuals & balances ------------------------

    // TX-068: deleting a transaction drops the assigned line's actual and gives the account its
    // money back — both are derived at read time, so removal alone re-derives them.
    [Fact]
    public async Task Delete_DropsTheLineActual_AndRestoresTheAccountBalance()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");
        var joint = SeedAccount(db, "Joint", 1250m);

        var tx = new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Tesco",
            Amount = 40m,
            Type = TransactionType.Expense,
            BudgetItemId = f.GroceriesId,
            AccountId = joint.Id,
        };
        db.Transactions.Add(tx);
        await db.SaveChangesAsync();

        (await ActualOf(db, user, f.GroceriesId)).Should().Be(40m);
        (await BalanceOf(db, user, joint.Id)).Should().Be(1210m); // 1250 − 40

        await new DeleteTransactionCommandHandler(db, user)
            .Handle(new DeleteTransactionCommand(tx.Id), CancellationToken.None);

        (await ActualOf(db, user, f.GroceriesId)).Should().Be(0m);
        (await BalanceOf(db, user, joint.Id)).Should().Be(1250m); // fully restored
    }

    // TX-071: a transfer is a single row (source = AccountId, destination = TransferAccountId);
    // deleting it hands both legs' money back at once.
    [Fact]
    public async Task DeletingATransfer_RestoresBothAccountBalances()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");
        var joint = SeedAccount(db, "Joint", 1250m);
        var rainy = SeedAccount(db, "Rainy Day", 500m);

        await new CreateTransferCommandHandler(db, user).Handle(
            new CreateTransferCommand(new DateOnly(2026, 7, 10), 100m, joint.Id, rainy.Id),
            CancellationToken.None);

        (await BalanceOf(db, user, joint.Id)).Should().Be(1150m); // 1250 − 100
        (await BalanceOf(db, user, rainy.Id)).Should().Be(600m);  // 500 + 100

        var transferId = (await db.Transactions.SingleAsync()).Id;
        await new DeleteTransactionCommandHandler(db, user)
            .Handle(new DeleteTransactionCommand(transferId), CancellationToken.None);

        (await BalanceOf(db, user, joint.Id)).Should().Be(1250m);
        (await BalanceOf(db, user, rainy.Id)).Should().Be(500m);
    }

    // --- ExcludeFromAllocation has no transaction-side effect ----------------

    // TX-095: an expense assigned to a line inside an ExcludeFromAllocation category still counts
    // to that line's actual exactly like any other line — BudgetActuals never reads the flag (it
    // only changes the income-allocation pool, asserted elsewhere).
    [Fact]
    public async Task ExcludeFromAllocationCategory_StillCountsTheTransactionToTheLineActual()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub("user-1");

        var personal = new BudgetItem { Name = "Personal Savings", PlannedAmount = 0m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Personal Savings",
                    Kind = CategoryKind.Expense,
                    ExcludeFromAllocation = true, // the flag under test
                    Items = new List<BudgetItem> { personal },
                },
            },
        });
        await db.SaveChangesAsync();

        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            Date = new DateOnly(2026, 7, 10),
            Payee = "Broker",
            Amount = 50m,
            Type = TransactionType.Expense,
            BudgetItemId = personal.Id,
        });
        await db.SaveChangesAsync();

        (await ActualOf(db, user, personal.Id)).Should().Be(50m);
    }

    // --- Server-side validation & filter semantics ---------------------------

    // TX-026: an amount above the supported range is rejected by the server validator with the
    // specific message (the client parse succeeds, so this is the backstop).
    [Fact]
    public void Validator_RejectsAmountAboveTheSupportedRange()
    {
        var validator = new CreateTransactionCommandValidator();

        var result = validator.Validate(new CreateTransactionCommand(
            new DateOnly(2026, 7, 10), "x", 100_000_000_000_000m, TransactionType.Expense, null));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.ErrorMessage == "Amount exceeds the supported range.");
    }

    // TX-076: the server's unassignedOnly filter is BudgetItemId == null, which is WIDER than the
    // UI's Unassigned view — it includes transfers and split parents (both carry a null
    // BudgetItemId), and excludes only truly assigned whole transactions.
    [Fact]
    public async Task ServerUnassignedOnly_IncludesTransfersAndSplitParents()
    {
        await using var db = NewContext();
        var f = SeedMonth(db);
        var user = new CurrentUserStub("user-1");

        // Assigned whole expense — the only row that should be excluded.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "Assigned", Amount = 10m,
            Type = TransactionType.Expense, BudgetItemId = f.GroceriesId,
        });
        // Plain unassigned expense.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "Unassigned", Amount = 20m,
            Type = TransactionType.Expense, BudgetItemId = null,
        });
        // Transfer — carries a null BudgetItemId.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "Transfer", Amount = 30m,
            Type = TransactionType.Transfer, BudgetItemId = null,
        });
        // Split parent — BudgetItemId is null while the slices carry the attribution.
        var splitParent = new Transaction
        {
            OwnerId = "user-1", Payee = "Split", Amount = 40m,
            Type = TransactionType.Expense, BudgetItemId = null,
        };
        splitParent.Splits.Add(new TransactionSplit { BudgetItemId = f.GroceriesId, Amount = 40m });
        db.Transactions.Add(splitParent);
        await db.SaveChangesAsync();

        var result = await new GetTransactionsQueryHandler(db, user)
            .Handle(new GetTransactionsQuery(UnassignedOnly: true), CancellationToken.None);

        result.Select(t => t.Payee).Should().BeEquivalentTo("Unassigned", "Transfer", "Split");
    }
}
