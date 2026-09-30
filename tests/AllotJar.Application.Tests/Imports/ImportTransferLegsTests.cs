using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// W07 import identity: each statement proves only its own bank's leg. A debit row marked as a
/// transfer records a confirmed departure (rule 71); a credit row records a receipt held for review
/// (rule 72); the second statement confirms the other side of the same movement only when the user
/// selects the candidate (rules 8/50/51), and re-importing either statement changes nothing.
/// Balances are read through the dated ledger. Expected figures follow the agreed examples.
/// </summary>
public class ImportTransferLegsTests
{
    private static readonly CurrentUserStub User = new("user-1");
    private static readonly DateOnly Opening = new(2026, 9, 1);
    private static readonly DateOnly Departure = new(2026, 9, 30);
    private static readonly DateOnly Receipt = new(2026, 10, 1);
    private static readonly DateOnly Later = new(2026, 10, 5);

    // Account A's statement: the debit leg of a 100 transfer, posted 30 September.
    private const string SourceStatement = """
        30/09/2026,TRANSFER TO SAVINGS     * 30/09/2026 •••• •••• •••• 4242 -100.00 EUR,-100.00
        """;

    // Account B's statement: the credit leg of the same movement, posted 1 October.
    private const string DestinationStatement = """
        01/10/2026,TRANSFER FROM CURRENT   * 01/10/2026 •••• •••• •••• 4242 100.00 EUR,100.00
        """;

    private static PreviewImportCommandHandler NewPreview(ApplicationDbContext db, string userId = "user-1") =>
        new(db, new CurrentUserStub(userId),
            new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
            new GenericCsvImporter());

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db, string userId = "user-1") =>
        new(db, new CurrentUserStub(userId));

    private static Account SeedAccount(ApplicationDbContext db, string name, decimal opening, string owner = "user-1")
    {
        var account = new Account
        {
            OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = Opening,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid? accountId) =>
        NewPreview(db).Handle(new PreviewImportCommand(content, StatementFormat.HsbcCsv, AccountId: accountId), CancellationToken.None);

    private static CommitImportItem AsTransfer(ImportCandidate row, Guid counterparty, Guid? matchTransferId = null) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null,
            TransferAccountId: counterparty, MatchTransferId: matchTransferId);

    private static async Task<Dictionary<Guid, AllotJar.Application.Accounts.Dtos.AccountDto>> AccountsAsOf(
        ApplicationDbContext db, DateOnly asOf) =>
        (await new GetAccountsQueryHandler(db, User).Handle(new GetAccountsQuery(asOf), CancellationToken.None))
        .ToDictionary(a => a.Id);

    /// <summary>Imports A's debit row as a transfer to B and returns the recorded transfer.</summary>
    private static async Task<Transaction> ImportDepartureAsync(ApplicationDbContext db, Account a, Account b)
    {
        var preview = await PreviewAsync(db, SourceStatement, a.Id);
        var row = preview.Items.Single(i => !i.IsCredit);
        var result = await NewCommit(db).Handle(
            new CommitImportCommand(a.Id, new[] { AsTransfer(row, b.Id) }), CancellationToken.None);
        result.Transfers.Should().Be(1);
        return await db.Transactions.SingleAsync(t => t.Type == TransactionType.Transfer);
    }

    [Fact]
    public async Task DebitRowMarkedAsTransfer_RecordsAConfirmedDeparture_WithReceiptUnknown()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);

        var preview = await PreviewAsync(db, SourceStatement, a.Id);
        var row = preview.Items.Single();
        var result = await NewCommit(db).Handle(
            new CommitImportCommand(a.Id, new[] { AsTransfer(row, b.Id) }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.Transfers.Should().Be(1);
        result.PendingReviewTransfers.Should().Be(0);
        var transfer = await db.Transactions.SingleAsync();
        transfer.AccountId.Should().Be(a.Id);
        transfer.TransferAccountId.Should().Be(b.Id);
        transfer.DepartedOn.Should().Be(Departure);
        transfer.ReceivedOn.Should().BeNull("B's bank has not shown the credit yet");
        transfer.BankReference.Should().Be(row.Reference);
        transfer.ReceiptBankReference.Should().BeNull();
        transfer.TransferStatus.Should().Be(TransferStatus.InTransit);

        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(900m);
        views[b.Id].CurrentBalance.Should().Be(200m);
        views[a.Id].InTransitOut.Should().Be(100m);
    }

    [Fact]
    public async Task CreditRowMarkedAsTransfer_IsHeldForReview_WithNoPostedEffect()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 500m);
        var b = SeedAccount(db, "B", 200m);

        var preview = await PreviewAsync(db, DestinationStatement, b.Id);
        var row = preview.Items.Single();
        row.IsCredit.Should().BeTrue();
        var result = await NewCommit(db).Handle(
            new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id) }), CancellationToken.None);

        result.Transfers.Should().Be(1);
        result.PendingReviewTransfers.Should().Be(1);
        var transfer = await db.Transactions.SingleAsync();
        transfer.AccountId.Should().Be(a.Id);
        transfer.TransferAccountId.Should().Be(b.Id);
        transfer.DepartedOn.Should().BeNull("only the user or A's statement can supply the departure");
        transfer.ReceivedOn.Should().Be(Receipt);
        transfer.ReceiptBankReference.Should().Be(row.Reference);
        transfer.BankReference.Should().BeNull();
        transfer.TransferStatus.Should().Be(TransferStatus.PendingReview);

        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(500m, "A must not be debited on an unknown date");
        views[b.Id].CurrentBalance.Should().Be(200m, "B must not be credited to 300 while A stays at 500");
        views[b.Id].PendingReceiptCount.Should().Be(1);
        views[b.Id].PendingReceiptTotal.Should().Be(100m);
        views[b.Id].RequiresReview.Should().BeTrue();
    }

    // ── Rule 51: current −100 and savings +100, not −200/+200.
    [Fact]
    public async Task ImportingBothStatements_ConfirmsOneMovement_WhenTheUserMatchesTheSecondSide()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfer = await ImportDepartureAsync(db, a, b);

        var preview = await PreviewAsync(db, DestinationStatement, b.Id);
        var row = preview.Items.Single();
        row.LikelyTransfer.Should().BeTrue("an open leg of the same amount is worth showing");
        var candidate = row.TransferMatches.Should().ContainSingle().Subject;
        candidate.TransferId.Should().Be(transfer.Id);
        candidate.CounterpartyAccountId.Should().Be(a.Id);
        candidate.CounterpartyAccountName.Should().Be("A");
        candidate.DepartedOn.Should().Be(Departure);
        candidate.ReceivedOn.Should().BeNull();

        var result = await NewCommit(db).Handle(
            new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, matchTransferId: candidate.TransferId) }),
            CancellationToken.None);

        result.Imported.Should().Be(0, "confirming a leg creates no transaction");
        result.MatchedTransfers.Should().Be(1);
        result.Transfers.Should().Be(1);
        result.PendingReviewTransfers.Should().Be(0);

        var stored = await db.Transactions.SingleAsync();
        stored.Id.Should().Be(transfer.Id);
        stored.DepartedOn.Should().Be(Departure);
        stored.ReceivedOn.Should().Be(Receipt);
        stored.BankReference.Should().NotBeNullOrEmpty();
        stored.ReceiptBankReference.Should().Be(row.Reference);
        stored.ReceiptBankReference.Should().NotBe(stored.BankReference, "each bank keeps its own reference");

        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(900m);
        views[b.Id].CurrentBalance.Should().Be(300m);
        views[a.Id].InTransitOut.Should().Be(0m);
    }

    // ── Rule 72 example resolved by matching A's statement afterwards: A 400 / B 300.
    [Fact]
    public async Task ReceiptFirst_ThenTheSourceStatement_ResolvesThePendingReceipt()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 500m);
        var b = SeedAccount(db, "B", 200m);
        var receiptRow = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        await NewCommit(db).Handle(new CommitImportCommand(b.Id, new[] { AsTransfer(receiptRow, a.Id) }), CancellationToken.None);
        var pending = await db.Transactions.SingleAsync();

        var preview = await PreviewAsync(db, SourceStatement, a.Id);
        var debitRow = preview.Items.Single();
        var candidate = debitRow.TransferMatches.Should().ContainSingle().Subject;
        candidate.TransferId.Should().Be(pending.Id);
        candidate.CounterpartyAccountId.Should().Be(b.Id);
        candidate.ReceivedOn.Should().Be(Receipt);
        candidate.DepartedOn.Should().BeNull();

        var result = await NewCommit(db).Handle(
            new CommitImportCommand(a.Id, new[] { AsTransfer(debitRow, b.Id, matchTransferId: pending.Id) }), CancellationToken.None);
        result.MatchedTransfers.Should().Be(1);

        var stored = await db.Transactions.SingleAsync();
        stored.DepartedOn.Should().Be(Departure);
        stored.BankReference.Should().Be(debitRow.Reference);
        stored.Date.Should().Be(Departure);
        stored.TransferStatus.Should().Be(TransferStatus.Completed);

        var onDeparture = await AccountsAsOf(db, Departure);
        onDeparture[a.Id].CurrentBalance.Should().Be(400m);
        onDeparture[b.Id].CurrentBalance.Should().Be(200m);
        onDeparture[b.Id].InTransitIn.Should().Be(100m);

        var afterReceipt = await AccountsAsOf(db, Later);
        afterReceipt[a.Id].CurrentBalance.Should().Be(400m);
        afterReceipt[b.Id].CurrentBalance.Should().Be(300m);
        afterReceipt[b.Id].RequiresReview.Should().BeFalse();
    }

    [Fact]
    public async Task ReImportingEitherStatement_IsRecognisedAsAlreadyKnown_OnItsOwnLeg()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfer = await ImportDepartureAsync(db, a, b);
        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        await NewCommit(db).Handle(
            new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, matchTransferId: transfer.Id) }), CancellationToken.None);

        var sourceAgain = await PreviewAsync(db, SourceStatement, a.Id);
        sourceAgain.NewCount.Should().Be(0);
        sourceAgain.SkippedDuplicates.Should().Be(1);

        var destinationAgain = await PreviewAsync(db, DestinationStatement, b.Id);
        destinationAgain.NewCount.Should().Be(0);
        destinationAgain.SkippedDuplicates.Should().Be(1);

        // A double-submitted commit of the receipt row is skipped, not applied twice.
        var resubmit = await NewCommit(db).Handle(
            new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, matchTransferId: transfer.Id) }), CancellationToken.None);
        resubmit.SkippedDuplicates.Should().Be(1);
        resubmit.MatchedTransfers.Should().Be(0);
        (await db.Transactions.CountAsync()).Should().Be(1);
        (await AccountsAsOf(db, Later))[b.Id].CurrentBalance.Should().Be(300m);
    }

    // ── Two banks may print the same reference on their own leg of one movement (an end-to-end id).
    [Fact]
    public async Task ASourceReferenceSharedByTheReceiptRow_DoesNotHideTheFirstReceiptImport()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var reference = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single().Reference;
        // A's departure, recorded with the reference B's statement will carry too; receipt unknown.
        var transfer = new Transaction
        {
            OwnerId = "user-1", Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.Eur, Date = Departure,
            Payee = "Transfer to savings", AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = Departure, BankReference = reference,
        };
        db.Transactions.Add(transfer);
        await db.SaveChangesAsync();

        // B's statement: the receipt row is new to B and the transfer is offered as its other side.
        var preview = await PreviewAsync(db, DestinationStatement, b.Id);
        preview.SkippedDuplicates.Should().Be(0);
        var row = preview.Items.Single();
        row.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id);

        var result = await NewCommit(db).Handle(
            new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, matchTransferId: transfer.Id) }), CancellationToken.None);
        result.MatchedTransfers.Should().Be(1);
        result.SkippedDuplicates.Should().Be(0);
        var stored = await db.Transactions.AsNoTracking().SingleAsync();
        stored.ReceivedOn.Should().Be(Receipt);
        stored.ReceiptBankReference.Should().Be(reference);
        (await AccountsAsOf(db, Later))[b.Id].CurrentBalance.Should().Be(300m);

        // Recorded on both legs, the same row is now known to B.
        (await PreviewAsync(db, DestinationStatement, b.Id)).SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task ALegacyInboundTransfer_ReceivedWithoutAReceiptReference_IsStillKnownToTheDestination_BySourceReference()
    {
        // Rows recorded before receipt references existed kept B's statement reference on the
        // source leg and were marked received on their date by the migration, and marked
        // ReceiptKnownBySourceReference by a later one; only those, not a transfer still in
        // transit nor a receipt confirmed by hand, lend their source reference to the destination.
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        db.Transactions.AddRange(
            new Transaction
            {
                OwnerId = "user-1", Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.Eur, Date = Departure, Payee = "Legacy",
                AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = Departure, ReceivedOn = Departure, BankReference = "LEGACY-1",
                ReceiptKnownBySourceReference = true,
            },
            new Transaction
            {
                OwnerId = "user-1", Type = TransactionType.Transfer, Amount = 70m, Currency = CurrencyCode.Eur, Date = Departure, Payee = "By hand",
                AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = Departure, ReceivedOn = Departure, BankReference = "HAND-1",
            },
            new Transaction
            {
                OwnerId = "user-1", Type = TransactionType.Transfer, Amount = 50m, Currency = CurrencyCode.Eur, Date = Departure, Payee = "In transit",
                AccountId = a.Id, TransferAccountId = b.Id, DepartedOn = Departure, BankReference = "OPEN-1",
            });
        await db.SaveChangesAsync();

        var knownToA = await StatementReferences.KnownAsync(db, "user-1", a.Id, CancellationToken.None);
        var knownToB = await StatementReferences.KnownAsync(db, "user-1", b.Id, CancellationToken.None);

        knownToA.Contains("LEGACY-1").Should().BeTrue();
        knownToA.Contains("OPEN-1").Should().BeTrue();
        knownToA.Contains("HAND-1").Should().BeTrue();
        knownToB.Contains("LEGACY-1").Should().BeTrue();
        knownToB.Contains("OPEN-1").Should().BeFalse();
        knownToB.Contains("HAND-1").Should().BeFalse("a receipt confirmed by hand is confirmed, not skipped, by B's statement (#279 P3-3)");
    }

    // ── Rule 50: two recorded transfers of 100 could match one statement entry of 100.
    [Fact]
    public async Task TwoEqualTransfers_ProduceTwoCandidates_AndNoneIsChosenAutomatically()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfers = new CreateTransferCommandHandler(db, User);
        var earlier = await transfers.Handle(new CreateTransferCommand(new DateOnly(2026, 9, 25), 100m, a.Id, b.Id), CancellationToken.None);
        var nearer = await transfers.Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        row.TransferMatches.Should().HaveCount(2);
        row.TransferMatches.Select(m => m.TransferId).Should().ContainInOrder(nearer.Id, earlier.Id);

        // Without a user choice the row is its own pending receipt; neither transfer is touched.
        await NewCommit(db).Handle(new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id) }), CancellationToken.None);

        (await db.Transactions.CountAsync(t => t.Type == TransactionType.Transfer)).Should().Be(3);
        (await db.Transactions.CountAsync(t => t.ReceivedOn != null)).Should().Be(1);
        (await db.Transactions.SingleAsync(t => t.ReceivedOn != null)).DepartedOn.Should().BeNull();
        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(800m);
        views[b.Id].CurrentBalance.Should().Be(200m);
        views[b.Id].PendingReceiptCount.Should().Be(1);
    }

    [Fact]
    public async Task Match_IsRejected_WhenAmountAccountsOrLegDisagree_AndNothingIsPersisted()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var c = SeedAccount(db, "C", 300m);
        var transfers = new CreateTransferCommandHandler(db, User);
        var wrongAmount = await transfers.Handle(new CreateTransferCommand(Departure, 150m, a.Id, b.Id), CancellationToken.None);
        var alreadyReceived = await transfers.Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id, ReceivedOn: Receipt), CancellationToken.None);
        // B's statement already confirmed that receipt (an app-recorded receipt is still open to it).
        (await db.Transactions.SingleAsync(t => t.Id == alreadyReceived.Id)).ReceiptBankReference = "B-STATEMENT-9";
        await db.SaveChangesAsync();
        var otherSource = await transfers.Handle(new CreateTransferCommand(Departure, 100m, c.Id, b.Id), CancellationToken.None);
        var foreign = SeedAccount(db, "Theirs", 100m, owner: "user-2");
        var foreignDest = SeedAccount(db, "Theirs too", 0m, owner: "user-2");
        var theirs = await new CreateTransferCommandHandler(db, new CurrentUserStub("user-2"))
            .Handle(new CreateTransferCommand(Departure, 100m, foreign.Id, foreignDest.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        var snapshot = await db.Transactions.AsNoTracking().OrderBy(t => t.Id).ToListAsync();

        async Task<ValidationException> Reject(Guid transferId, Guid counterparty)
        {
            var ex = await Assert.ThrowsAsync<ValidationException>(() =>
                NewCommit(db).Handle(new CommitImportCommand(b.Id, new[] { AsTransfer(row, counterparty, matchTransferId: transferId) }),
                    CancellationToken.None));
            return ex;
        }

        // 150 left and 100 arrived: only a fee the row states explicitly can explain it (O1 answer 5).
        (await Reject(wrongAmount.Id, a.Id)).Errors["Items"].Single().Should().Contain("too large a difference to be a fee");
        (await Reject(alreadyReceived.Id, a.Id)).Errors["Items"].Single().Should().Contain("already confirmed");
        (await Reject(otherSource.Id, a.Id)).Errors["Items"].Single().Should().Contain("different accounts");
        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            NewCommit(db).Handle(new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, matchTransferId: theirs.Id) }),
                CancellationToken.None));

        // The same open leg cannot be confirmed by two rows of one import.
        var open = await transfers.Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id), CancellationToken.None);
        var twice = await Assert.ThrowsAsync<ValidationException>(() =>
            NewCommit(db).Handle(new CommitImportCommand(b.Id, new[]
            {
                AsTransfer(row, a.Id, matchTransferId: open.Id),
                AsTransfer(row with { Reference = row.Reference + "-dup" }, a.Id, matchTransferId: open.Id),
            }), CancellationToken.None));
        twice.Errors["Items"].Single().Should().Contain("already confirms");

        var after = await db.Transactions.AsNoTracking().OrderBy(t => t.Id).ToListAsync();
        after.Where(t => t.Id != open.Id).Should().BeEquivalentTo(snapshot, "a rejected match must leave every transfer untouched");
        (await db.Transactions.CountAsync(t => t.ReceiptBankReference != null)).Should().Be(1, "only the receipt B's statement confirmed before");
    }

    [Fact]
    public async Task Candidates_RequireAStatementAccount_AndAMatchIsTheTransferItNames()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        await ImportDepartureAsync(db, a, b);

        var unscoped = await PreviewAsync(db, DestinationStatement, accountId: null);
        unscoped.Items.Single().TransferMatches.Should().BeEmpty("no statement account, no leg to confirm");

        var validator = new CommitImportCommandValidator();
        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        var candidate = row.TransferMatches.Single();
        // A match may leave the counterparty to the transfer (its other side can be private, P57),
        // but it is that transfer: no budget line besides.
        var named = new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null,
            MatchTransferId: candidate.TransferId);
        validator.Validate(new CommitImportCommand(b.Id, new[] { named })).IsValid.Should().BeTrue();
        validator.Validate(new CommitImportCommand(b.Id, new[] { named with { BudgetItemId = Guid.NewGuid() } })).IsValid.Should().BeFalse();
        validator.Validate(new CommitImportCommand(b.Id, new[] { AsTransfer(row, a.Id, candidate.TransferId) })).IsValid.Should().BeTrue();
    }
}
