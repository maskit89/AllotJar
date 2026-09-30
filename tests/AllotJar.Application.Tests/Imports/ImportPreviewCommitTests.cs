using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class ImportPreviewCommitTests
{
    // Both parsers, in DI registration order — sniffing must pick the right one, not the only one.
    private static PreviewImportCommandHandler NewPreview(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId),
            new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
            new GenericCsvImporter());

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db, string userId) =>
        new(db, new CurrentUserStub(userId));

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

    private static HouseholdMember SeedMember(ApplicationDbContext db, string ownerId, string name = "Alex")
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
    public async Task Preview_Dedup_MatchesTheCommitsAccountScope_EitherLeg_CaseInsensitive()
    {
        // 2026-07-22 re-review F6: the preview's already-imported filter must agree with the
        // commit's — scoped to the statement account (either transaction leg, since an inbound
        // transfer is stored with the counterparty as its source), case-insensitive to match the
        // index collation. The old filter was owner-wide AND case-sensitive.
        await using var db = NewContext();
        var statementAccount = SeedAccount(db, "user-1", "Statement");
        var otherAccount = SeedAccount(db, "user-1", "Other");

        // Learn the parser's synthesized references from a clean preview.
        var clean = await NewPreview(db, "user-1").Handle(
            new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.HsbcCsv,
                AccountId: statementAccount.Id),
            CancellationToken.None);
        var refs = clean.Items.Select(i => i.Reference).Distinct().ToList();
        refs.Count.Should().BeGreaterThan(2);

        // A transfer row carries both bank legs on its date, as the AccountOpeningDatesAndTransferLegs
        // migration left every row recorded before the legs existed (rule 51).
        Transaction Row(string reference, Guid? accountId, Guid? transferAccountId = null) => new()
        {
            OwnerId = "user-1", Amount = 10m, Currency = CurrencyCode.Eur,
            Type = transferAccountId is null ? TransactionType.Expense : TransactionType.Transfer,
            Date = new DateOnly(2026, 6, 15), Payee = "SEEDED", BankReference = reference,
            AccountId = accountId, TransferAccountId = transferAccountId,
            DepartedOn = transferAccountId is null ? null : new DateOnly(2026, 6, 15),
            ReceivedOn = transferAccountId is null ? null : new DateOnly(2026, 6, 15),
        };

        db.Transactions.AddRange(
            // On the statement account, as a CASE VARIANT — must hide (the commit would skip it).
            Row(refs[0].ToUpperInvariant(), statementAccount.Id),
            // A legacy inbound transfer: its receipt recorded, the statement account's reference kept
            // on the source leg, statement account as destination — must hide.
            Row(refs[1], otherAccount.Id, transferAccountId: statementAccount.Id),
            // The same reference on a DIFFERENT account entirely — genuinely distinct, must stay visible.
            Row(refs[2], otherAccount.Id));
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(
            new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.HsbcCsv,
                AccountId: statementAccount.Id),
            CancellationToken.None);

        var visible = result.Items.Select(i => i.Reference).ToList();
        visible.Should().NotContain(refs[0]);
        visible.Should().NotContain(refs[1]);
        visible.Should().Contain(refs[2]);
        result.SkippedDuplicates.Should().Be(clean.TotalEntries - result.NewCount);
    }

    [Fact]
    public async Task Preview_Rejects_AnAccountTheCallerDoesNotOwn()
    {
        await using var db = NewContext();
        var foreign = SeedAccount(db, "user-2", "Their account");

        await FluentActions.Invoking(() => NewPreview(db, "user-1").Handle(
                new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.HsbcCsv,
                    AccountId: foreign.Id),
                CancellationToken.None))
            .Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task Preview_GenericCsv_DetectsLayout_AndStampsTheDefaultCurrency()
    {
        await using var db = NewContext();
        const string csv =
            "Date,Description,Amount\n" +
            "2026-06-20,TESCO,-42.50\n" +
            "2026-06-21,SALARY,2500.00\n";
        var command = new PreviewImportCommand(csv, StatementFormat.GenericCsv, Mapping: null, DefaultCurrency: "GBP");

        var result = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);

        // The detected layout is echoed back for the mapping UI, with the home currency injected.
        result.Layout.Should().NotBeNull();
        result.Layout!.Columns.Should().Contain("Amount");
        result.Layout.Suggested.DefaultCurrency.Should().Be("GBP");

        // Rows parsed, stamped with the default currency, and given a csv: idempotency key.
        result.Items.Should().HaveCount(2);
        result.Items.Should().OnlyContain(i => i.Currency == "GBP");
        result.Items.Should().OnlyContain(i => i.Reference.StartsWith("csv:"));
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

    // --- Format sniffing (a "generic" upload of a known format) ----------------

    [Fact]
    public async Task Preview_GenericUpload_OfHsbcContent_IsRoutedToTheHsbcParser()
    {
        await using var db = NewContext();
        var command = new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.GenericCsv);

        var result = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);

        // Same file, same path: clean payees, hsbc: references, no column-mapping UI.
        result.DetectedFormat.Should().Be(nameof(StatementFormat.HsbcCsv));
        result.Layout.Should().BeNull();
        result.Items.Should().OnlyContain(i => i.Reference.StartsWith("hsbc:"));
        result.Items.Should().Contain(i => i.Payee == "AUTOMARKET SER STATION");
    }

    [Fact]
    public async Task Preview_GenericUpload_SkipsRowsAlreadyImportedThroughTheHsbcFormat()
    {
        await using var db = NewContext();
        // Import the statement through the dedicated HSBC path first...
        var first = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);
        await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(null, ToCommitItems(first)), CancellationToken.None);

        // ...then upload the SAME file again with the format dropdown left on "generic".
        var second = await NewPreview(db, "user-1").Handle(
            new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.GenericCsv), CancellationToken.None);

        // Sniffing routes it back to the HSBC parser, so every row is recognised as imported.
        second.NewCount.Should().Be(0);
        second.SkippedDuplicates.Should().Be(6);
    }

    [Fact]
    public async Task Preview_ConfirmedMapping_StaysOnTheGenericPath()
    {
        await using var db = NewContext();
        // Once the user has confirmed a column mapping they are explicitly in the generic flow —
        // don't yank the mapping UI out from under them mid-review.
        var mapping = new CsvMapping(',', HasHeader: false, DateColumn: 0, AmountColumn: 2,
            DescriptionColumn: 1, CurrencyColumn: null, DateFormat: null,
            DecimalStyle: CsvDecimalStyle.Auto, DefaultCurrency: "EUR");
        var command = new PreviewImportCommand(HsbcCsvSamples.Mixed, StatementFormat.GenericCsv, mapping);

        var result = await NewPreview(db, "user-1").Handle(command, CancellationToken.None);

        result.DetectedFormat.Should().Be(nameof(StatementFormat.GenericCsv));
        result.Layout.Should().NotBeNull();
        result.Items.Should().OnlyContain(i => i.Reference.StartsWith("csv:"));
    }

    // --- Possible duplicates (content-level hint) -------------------------------

    [Fact]
    public async Task Preview_FlagsPossibleDuplicates_ThatMatchAnExistingTransaction()
    {
        await using var db = NewContext();
        db.Transactions.AddRange(
            // Same amount + payee as the AUTOMARKET row (booked 17/06), one day apart → flagged.
            new Transaction
            {
                OwnerId = "user-1", Payee = "AUTOMARKET SER STATION", Amount = 35.00m,
                Date = new DateOnly(2026, 6, 18), Type = TransactionType.Expense,
            },
            // Same amount + payee as PLANET PLAY RESTAURA but weeks away → NOT flagged.
            new Transaction
            {
                OwnerId = "user-1", Payee = "PLANET PLAY RESTAURA", Amount = 67.75m,
                Date = new DateOnly(2026, 5, 1), Type = TransactionType.Expense,
            });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION").PossibleDuplicate.Should().BeTrue();
        result.Items.Single(i => i.Payee == "PLANET PLAY RESTAURA").PossibleDuplicate.Should().BeFalse();
        result.Items.Single(i => i.Payee == "4 PILLARS").PossibleDuplicate.Should().BeFalse();
        // A hint only — flagged rows still come back as importable candidates.
        result.NewCount.Should().Be(6);
    }

    [Fact]
    public async Task Preview_PossibleDuplicate_MatchesWhenOnePayeeContainsTheOther()
    {
        await using var db = NewContext();
        // An earlier import through the raw generic path stored the whole packed blob as the
        // payee; the clean HSBC payee is contained in it, so the hint still fires.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            Payee = "AUTOMARKET SER STATION * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR",
            Amount = 35.00m, Date = new DateOnly(2026, 6, 19), Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION").PossibleDuplicate.Should().BeTrue();
    }

    [Theory]
    [InlineData(2026, 6, 21, true)]  // exactly 4 days after the 17/06 booking — inside the window
    [InlineData(2026, 6, 22, false)] // 5 days — outside
    public async Task Preview_PossibleDuplicate_WindowBoundary(int y, int m, int d, bool flagged)
    {
        await using var db = NewContext();
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Payee = "AUTOMARKET SER STATION", Amount = 35.00m,
            Date = new DateOnly(y, m, d), Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION")
            .PossibleDuplicate.Should().Be(flagged);
    }

    [Fact]
    public async Task Preview_PossibleDuplicate_RequiresMatchingDirectionAndCurrency()
    {
        await using var db = NewContext();
        db.Transactions.AddRange(
            // Same amount/payee/date as the AUTOMARKET debit, but recorded as Income → no match.
            new Transaction
            {
                OwnerId = "user-1", Payee = "AUTOMARKET SER STATION", Amount = 35.00m,
                Date = new DateOnly(2026, 6, 17), Type = TransactionType.Income,
            },
            // Same everything as the PLANET PLAY debit, but a different currency → no match.
            new Transaction
            {
                OwnerId = "user-1", Payee = "PLANET PLAY RESTAURA", Amount = 67.75m,
                Date = new DateOnly(2026, 6, 15), Type = TransactionType.Expense,
                Currency = CurrencyCode.From("GBP"),
            });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION").PossibleDuplicate.Should().BeFalse();
        result.Items.Single(i => i.Payee == "PLANET PLAY RESTAURA").PossibleDuplicate.Should().BeFalse();
    }

    [Fact]
    public async Task Preview_PossibleDuplicate_IgnoresOtherUsersTransactions()
    {
        await using var db = NewContext();
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-2", Payee = "AUTOMARKET SER STATION", Amount = 35.00m,
            Date = new DateOnly(2026, 6, 17), Type = TransactionType.Expense,
        });
        await db.SaveChangesAsync();

        var result = await NewPreview(db, "user-1").Handle(Preview(), CancellationToken.None);

        result.Items.Single(i => i.Payee == "AUTOMARKET SER STATION").PossibleDuplicate.Should().BeFalse();
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
        first.SkippedReferences.Should().BeEmpty();
        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(6);
        // The skipped rows are named by the reference the request sent, so the screen's money
        // totals can leave them out.
        second.SkippedReferences.Should().BeEquivalentTo(items.Select(i => i.Reference));
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

    // --- Shared financial invariants on the reviewed import (2026-07-22 re-review F3) ----

    private static CommitImportItem Item(
        string reference, DateOnly date, string payee, decimal amount, bool isCredit = false,
        string currency = "EUR", Guid? budgetItemId = null, Guid? transferAccountId = null,
        bool acknowledgeCrossMonth = false) =>
        new(reference, date, payee, amount, currency, isCredit,
            BudgetItemId: budgetItemId, MemberId: null, Splits: null,
            TransferAccountId: transferAccountId, AcknowledgeCrossMonth: acknowledgeCrossMonth);

    [Fact]
    public async Task Commit_RejectsAssigningACreditToAnExpenseLine()
    {
        // Direction↔kind now holds on the import path too: a credit (income) on an expense
        // line would sit invisible to BudgetActuals' kind-matched roll-up.
        await using var db = NewContext();
        var groceries = SeedGroceries(db, "user-1"); // expense line, June 2026

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, new List<CommitImportItem>
                {
                    Item("REF-1", new DateOnly(2026, 6, 10), "Refund", 25m, isCredit: true, budgetItemId: groceries.Id),
                }),
                CancellationToken.None));

        ex.Errors["Items"].Single().Should().Contain("income lines");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_AssigningAHistoricalRowToAnotherMonthsLine_NeedsAcknowledgment()
    {
        // A statement row dated May assigned to a June line: rejected under the crossMonth
        // key unless the reviewer explicitly confirmed budgeting it there.
        await using var db = NewContext();
        var groceries = SeedGroceries(db, "user-1"); // June 2026
        var may = new DateOnly(2026, 5, 27);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, new List<CommitImportItem>
                {
                    Item("REF-MAY", may, "4 PILLARS", 1770m, budgetItemId: groceries.Id),
                }),
                CancellationToken.None));
        ex.Errors.Should().ContainKey("crossMonth");
        (await db.Transactions.CountAsync()).Should().Be(0);

        var result = await NewCommit(db, "user-1").Handle(
            new CommitImportCommand(null, new List<CommitImportItem>
            {
                Item("REF-MAY", may, "4 PILLARS", 1770m, budgetItemId: groceries.Id, acknowledgeCrossMonth: true),
            }),
            CancellationToken.None);

        result.Imported.Should().Be(1);
        (await db.Transactions.SingleAsync()).BudgetItemId.Should().Be(groceries.Id);
    }

    [Fact]
    public async Task Commit_RejectsARowWhoseCurrencyDiffersFromTheImportAccount()
    {
        // The account-currency invariant every other write path enforces: a GBP row on an
        // EUR account would silently corrupt the (currency-blind) account balance.
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card"); // EUR by default

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db, "user-1").Handle(
                new CommitImportCommand(card.Id, new List<CommitImportItem>
                {
                    Item("REF-GBP", new DateOnly(2026, 6, 10), "London Cab", 45.50m, currency: "GBP"),
                }),
                CancellationToken.None));

        ex.Errors["Items"].Single().Should().Contain("EUR");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_RejectsACrossCurrencyTransfer()
    {
        // Same rule as /transfer: both legs move the raw amount, so a EUR->GBP transfer
        // would silently change net worth.
        await using var db = NewContext();
        var card = SeedAccount(db, "user-1", "HSBC card"); // EUR
        var gbp = new Account
        {
            OwnerId = "user-1", Name = "UK savings", Type = AccountType.Savings,
            Currency = CurrencyCode.From("GBP"),
        };
        db.Accounts.Add(gbp);
        await db.SaveChangesAsync();

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db, "user-1").Handle(
                new CommitImportCommand(card.Id, new List<CommitImportItem>
                {
                    Item("REF-T", new DateOnly(2026, 6, 10), "To UK", 100m, transferAccountId: gbp.Id),
                }),
                CancellationToken.None));

        ex.Errors["Items"].Single().Should().Contain("same currency");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_IsAtomic_OneInvalidRowImportsNothing()
    {
        // The whole batch validates before the single save: a bad row anywhere means no row
        // is persisted — never a half-imported statement.
        await using var db = NewContext();
        var groceries = SeedGroceries(db, "user-1");

        await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db, "user-1").Handle(
                new CommitImportCommand(null, new List<CommitImportItem>
                {
                    Item("REF-OK", new DateOnly(2026, 6, 10), "Fine unassigned row", 10m),
                    Item("REF-BAD", new DateOnly(2026, 6, 11), "Refund", 25m, isCredit: true, budgetItemId: groceries.Id),
                }),
                CancellationToken.None));

        (await db.Transactions.CountAsync()).Should().Be(0);
    }
}
