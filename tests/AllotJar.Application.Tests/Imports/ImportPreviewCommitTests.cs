using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class ImportPreviewCommitTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-prevcommit-{Guid.NewGuid()}")
            .Options);

    private static PreviewImportCommandHandler NewPreview(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId), new IStatementParser[] { new HsbcCsvStatementParser() });

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId), new FakeExchangeRateProvider());

    private static PreviewImportCommand Preview(string content = null!) =>
        new(content ?? HsbcCsvSamples.Mixed, StatementFormat.HsbcCsv);

    private static BudgetItem SeedGroceries(ApplicationDbContext db, string ownerId)
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Items = new List<BudgetItem> { groceries } },
            },
        });
        db.SaveChanges();
        return groceries;
    }

    private static HouseholdMember SeedMember(ApplicationDbContext db, string ownerId, string name = "Chris")
    {
        var member = new HouseholdMember { OwnerId = ownerId, Name = name };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member;
    }

    private static (BudgetItem Food, BudgetItem Soap) SeedTwoExpenseLines(ApplicationDbContext db, string ownerId)
    {
        var food = new BudgetItem { Name = "Food & drinks", PlannedAmount = 400m };
        var soap = new BudgetItem { Name = "Soap & toiletries", PlannedAmount = 50m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Home", Items = new List<BudgetItem> { food, soap } },
            },
        });
        db.SaveChanges();
        return (food, soap);
    }

    private static List<CommitImportItem> ToCommitItemsWithSplit(
        ImportPreviewResult preview, string payee, params (Guid lineId, decimal amount)[] slices) =>
        preview.Items.Select(c => c.Payee == payee
            ? new CommitImportItem(c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null,
                slices.Select(s => new CommitImportSplit(s.lineId, s.amount, null)).ToList())
            : new CommitImportItem(c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null))
        .ToList();

    private static Account SeedAccount(ApplicationDbContext db, string ownerId, string name)
    {
        var account = new Account { OwnerId = ownerId, Name = name, Type = AccountType.Current };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static List<CommitImportItem> ToCommitItemsAsTransfer(
        ImportPreviewResult preview, string payee, Guid transferAccountId) =>
        preview.Items.Select(c => c.Payee == payee
            ? new CommitImportItem(c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null,
                Splits: null, TransferAccountId: transferAccountId)
            : new CommitImportItem(c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit, null, null))
        .ToList();

    private static List<CommitImportItem> ToCommitItems(
        ImportPreviewResult preview, string? assignPayee = null, Guid? budgetItemId = null, Guid? memberId = null) =>
        preview.Items.Select(c => new CommitImportItem(
            c.Reference, c.Date, c.Payee, c.Amount, c.Currency, c.IsCredit,
            BudgetItemId: c.Payee == assignPayee ? budgetItemId : null,
            MemberId: c.Payee == assignPayee ? memberId : null)).ToList();

    // --- Preview --------------------------------------------------------------

    [Fact]
    public async Task Preview_ReturnsEveryFreshRow_WithCounts()
    {
        await using var db = NewContext();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.TotalEntries.Should().Be(6);
        result.NewCount.Should().Be(6);
        result.SkippedDuplicates.Should().Be(0);
        result.Credits.Should().Be(1);
        result.Debits.Should().Be(5);
        result.Items.Should().OnlyContain(i => i.Reference.StartsWith("hsbc:"));
        (await db.Transactions.CountAsync()).Should().Be(0); // nothing persisted by a preview
    }

    [Fact]
    public async Task Preview_SuggestsLine_FromPriorCategorization()
    {
        await using var db = NewContext();
        var groceries = SeedGroceries(db, "user-1");
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "AUTOMARKET SER STATION",
            BudgetItemId = groceries.Id, Date = new DateOnly(2026, 6, 1), Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        var automarket = result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION");
        automarket.SuggestedBudgetItemId.Should().Be(groceries.Id);
        automarket.SuggestedBudgetItemName.Should().Be("Groceries");
        result.Items.Single(i => i.Payee == "4 PILLARS").SuggestedBudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Preview_ExcludesRowsAlreadyImported()
    {
        await using var db = NewContext();
        // Learn a real reference from a first preview, then pretend it's already imported.
        var first = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var taken = first.Items[0];
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = taken.Payee, Amount = taken.Amount,
            Date = taken.Date, Type = TransactionType.Expense, BankReference = taken.Reference,
        });
        await db.SaveChangesAsync();

        var second = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        second.NewCount.Should().Be(5);
        second.SkippedDuplicates.Should().Be(1);
        second.Items.Should().NotContain(i => i.Reference == taken.Reference);
    }

    // --- Commit ---------------------------------------------------------------

    [Fact]
    public async Task Commit_PersistsChosenCategoryAndMember_AndTracksTheLine()
    {
        await using var db = NewContext();
        var groceries = SeedGroceries(db, "user-1");
        var member = SeedMember(db, "user-1");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItems(preview, "AUTOMARKET SER STATION", groceries.Id, member.Id);

        var result = await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(null, items), CancellationToken.None);

        result.Imported.Should().Be(6);
        var saved = await db.Transactions.SingleAsync(t => t.Payee == "AUTOMARKET SER STATION");
        saved.BudgetItemId.Should().Be(groceries.Id);
        saved.MemberId.Should().Be(member.Id);
    }

    [Fact]
    public async Task Commit_IsIdempotent_OnResubmit()
    {
        await using var db = NewContext();
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItems(preview);
        var handler = NewCommit(db, "user-1");

        var first = await handler.Handle(new CommitImportCommand(null, items), CancellationToken.None);
        var second = await handler.Handle(new CommitImportCommand(null, items), CancellationToken.None);

        first.Imported.Should().Be(6);
        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(6);
        (await db.Transactions.CountAsync()).Should().Be(6);
    }

    [Fact]
    public async Task Commit_StampsTheChosenAccount()
    {
        await using var db = NewContext();
        var account = new Account { OwnerId = "user-1", Name = "HSBC", Type = AccountType.Current };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(account.Id, ToCommitItems(preview)), CancellationToken.None);

        (await db.Transactions.CountAsync(t => t.AccountId == account.Id)).Should().Be(6);
    }

    [Fact]
    public async Task Commit_RejectsBudgetLineOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var foreignLine = SeedGroceries(db, "user-2");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItems(preview, "AUTOMARKET SER STATION", foreignLine.Id);

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, items), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();
        (await db.Transactions.CountAsync()).Should().Be(0); // nothing imported
    }

    [Fact]
    public async Task Commit_RejectsMemberOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var foreignMember = SeedMember(db, "user-2");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItems(preview, "AUTOMARKET SER STATION", budgetItemId: null, memberId: foreignMember.Id);

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, items), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // --- Splits ---------------------------------------------------------------

    [Fact]
    public async Task Commit_PersistsSplitRow_AcrossLines_AndTracksEachLine()
    {
        await using var db = NewContext();
        var (food, soap) = SeedTwoExpenseLines(db, "user-1");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        // AUTOMARKET is 35.00 → split 20.00 to food + 15.00 to soap.
        var items = ToCommitItemsWithSplit(preview, "AUTOMARKET SER STATION", (food.Id, 20m), (soap.Id, 15m));

        var result = await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(null, items), CancellationToken.None);

        result.Imported.Should().Be(6);
        var saved = await db.Transactions.Include(t => t.Splits)
            .SingleAsync(t => t.Payee == "AUTOMARKET SER STATION");
        saved.BudgetItemId.Should().BeNull();            // the slices carry the attribution now
        saved.Splits.Should().HaveCount(2);
        saved.Splits.Sum(s => s.Amount).Should().Be(35m);
        saved.Splits.Select(s => s.BudgetItemId).Should().BeEquivalentTo(new Guid?[] { food.Id, soap.Id });
    }

    [Fact]
    public async Task Commit_RejectsSplit_ThatDoesNotSumToTheAmount()
    {
        await using var db = NewContext();
        var (food, soap) = SeedTwoExpenseLines(db, "user-1");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItemsWithSplit(preview, "AUTOMARKET SER STATION", (food.Id, 20m), (soap.Id, 10m)); // 30 ≠ 35

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, items), CancellationToken.None))
            .Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_RejectsSplitLineOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var (food, _) = SeedTwoExpenseLines(db, "user-1");
        var foreign = SeedGroceries(db, "user-2");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItemsWithSplit(preview, "AUTOMARKET SER STATION", (food.Id, 20m), (foreign.Id, 15m));

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, items), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    // --- Transfers ------------------------------------------------------------

    [Fact]
    public async Task Preview_FlagsLikelyTransfers()
    {
        await using var db = NewContext();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "E-BANKING PAYMENT").LikelyTransfer.Should().BeTrue();
        result.Items.Single(i => i.Payee == "4 PILLARS").LikelyTransfer.Should().BeFalse();
    }

    [Fact]
    public async Task Commit_Transfer_Credit_MovesMoneyIntoTheImportAccount()
    {
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card");
        var savings = SeedAccount(db, "user-1", "Savings");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        // E-BANKING PAYMENT is the credit (money in) — moved from Savings into the card.
        var items = ToCommitItemsAsTransfer(preview, "E-BANKING PAYMENT", savings.Id);

        var result = await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(card.Id, items), CancellationToken.None);

        result.Transfers.Should().Be(1);
        var transfer = await db.Transactions.SingleAsync(t => t.Payee == "E-BANKING PAYMENT");
        transfer.Type.Should().Be(TransactionType.Transfer);
        transfer.AccountId.Should().Be(savings.Id);          // source = counterparty (credit)
        transfer.TransferAccountId.Should().Be(card.Id);     // destination = import account
        transfer.BudgetItemId.Should().BeNull();
    }

    [Fact]
    public async Task Commit_Transfer_Debit_MovesMoneyOutOfTheImportAccount()
    {
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card");
        var savings = SeedAccount(db, "user-1", "Savings");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        // AUTOMARKET is a debit (money out) — treat it as a move from the card to Savings.
        var items = ToCommitItemsAsTransfer(preview, "AUTOMARKET SER STATION", savings.Id);

        await NewCommit(db, "user-1").Handle(new CommitImportCommand(card.Id, items), CancellationToken.None);

        var transfer = await db.Transactions.SingleAsync(t => t.Payee == "AUTOMARKET SER STATION");
        transfer.Type.Should().Be(TransactionType.Transfer);
        transfer.AccountId.Should().Be(card.Id);             // source = import account (debit)
        transfer.TransferAccountId.Should().Be(savings.Id);  // destination = counterparty
    }

    [Fact]
    public async Task Commit_Transfer_RequiresAnImportAccount()
    {
        await using var db = NewContext();
        var savings = SeedAccount(db, "user-1", "Savings");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItemsAsTransfer(preview, "E-BANKING PAYMENT", savings.Id);

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, items), CancellationToken.None))
            .Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_Transfer_RejectsSameAccountOnBothLegs()
    {
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItemsAsTransfer(preview, "E-BANKING PAYMENT", card.Id); // counterparty == import

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(card.Id, items), CancellationToken.None))
            .Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_Transfer_RejectsCounterpartyOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card");
        var foreign = SeedAccount(db, "user-2", "Their account");
        var preview = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        var items = ToCommitItemsAsTransfer(preview, "E-BANKING PAYMENT", foreign.Id);

        await FluentActions.Invoking(() => NewCommit(db, "user-1").Handle(
                new CommitImportCommand(card.Id, items), CancellationToken.None))
            .Should().ThrowAsync<ForbiddenAccessException>();
        (await db.Transactions.CountAsync()).Should().Be(0);
    }
}
