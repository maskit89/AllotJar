using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// W07's O1 answers (29 September 2026): every candidate is listed (1, unchanged); a bank
/// reference reused for a different entry is shown, not skipped (2); a transfer is corrected in
/// place (3); a transfer can come back to its source (4); an explicit fee explains what left
/// beyond what arrived (5). Plus the defaults stated with them: a leg recorded in the app is
/// confirmed by its statement without moving money again, taking the bank's date (rules
/// 8/69/71); an import judges each day on its closing balance.
/// </summary>
public class TransferIdentityW07Tests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly DateOnly Opening = new(2026, 9, 1);
    private static readonly DateOnly Recorded = new(2026, 9, 29);
    private static readonly DateOnly Departure = new(2026, 9, 30);
    private static readonly DateOnly Receipt = new(2026, 10, 1);
    private static readonly DateOnly Returned = new(2026, 10, 3);
    private static readonly DateOnly Later = new(2026, 10, 5);

    // A's statement: 100 leaves for B on 30 September.
    private const string SourceStatement = """
        30/09/2026,TRANSFER TO SAVINGS     * 30/09/2026 •••• •••• •••• 4242 -100.00 EUR,-100.00
        """;

    // A's statement when the bank charged 2 on top: 102 leaves on 30 September.
    private const string SourceStatementWithFee = """
        30/09/2026,TRANSFER TO SAVINGS     * 30/09/2026 •••• •••• •••• 4242 -102.00 EUR,-102.00
        """;

    // B's statement: 100 arrives on 1 October.
    private const string DestinationStatement = """
        01/10/2026,TRANSFER FROM CURRENT   * 01/10/2026 •••• •••• •••• 4242 100.00 EUR,100.00
        """;

    // B's statement when 2 was taken on the way: 98 arrives on 1 October.
    private const string DestinationStatementLessFee = """
        01/10/2026,TRANSFER FROM CURRENT   * 01/10/2026 •••• •••• •••• 4242 98.00 EUR,98.00
        """;

    // A's statement: the 100 comes back on 3 October.
    private const string ReturnStatement = """
        03/10/2026,RETURNED PAYMENT        * 03/10/2026 •••• •••• •••• 4242 100.00 EUR,100.00
        """;

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-w07-{Guid.NewGuid()}")
            .Options);

    private static Account SeedAccount(ApplicationDbContext db, string name, decimal opening) =>
        LedgerFixtures.SeedAccount(db, Owner, name, opening, Opening, AccountType.Current);

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid accountId, StatementFormat format = StatementFormat.HsbcCsv) =>
        new PreviewImportCommandHandler(db, User,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, format, AccountId: accountId), CancellationToken.None);

    private static Task<ImportStatementResult> CommitAsync(ApplicationDbContext db, Guid accountId, params CommitImportItem[] items) =>
        new CommitImportCommandHandler(db, User, new FakeExchangeRateProvider())
            .Handle(new CommitImportCommand(accountId, items), CancellationToken.None);

    private static CommitImportItem Row(ImportCandidate row) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null);

    private static CreateTransferCommandHandler Transfers(ApplicationDbContext db) => new(db, User);

    private static async Task<Dictionary<Guid, AllotJar.Application.Accounts.Dtos.AccountDto>> AccountsAsOf(ApplicationDbContext db, DateOnly asOf) =>
        (await new GetAccountsQueryHandler(db, User).Handle(new GetAccountsQuery(asOf), CancellationToken.None)).ToDictionary(a => a.Id);

    private static async Task<Transaction> ReloadAsync(ApplicationDbContext db, Guid id)
    {
        db.ChangeTracker.Clear();
        return await db.Transactions.Include(t => t.Fee).SingleAsync(t => t.Id == id);
    }

    /// <summary>September and October 2026 with a "Bank fees" expense line each.</summary>
    private static (BudgetItem September, BudgetItem October) SeedFeeLines(ApplicationDbContext db)
    {
        BudgetItem Line(int month)
        {
            var line = new BudgetItem { Name = "Bank fees", PlannedAmount = 10m };
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = Owner, Year = 2026, Month = month, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory> { new() { Name = "Charges", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { line } } },
            });
            db.SaveChanges();
            return line;
        }
        return (Line(9), Line(10));
    }

    private static string Camt(string reference, DateOnly date, decimal amount, bool credit) => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
          <BkToCstmrStmt><Stmt><Id>S</Id>
            <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
            <Ntry>
              <Amt Ccy="EUR">{amount:0.00}</Amt>
              <CdtDbtInd>{(credit ? "CRDT" : "DBIT")}</CdtDbtInd>
              <BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt>
              <AcctSvcrRef>{reference}</AcctSvcrRef>
              <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Gym Ltd</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
            </Ntry>
          </Stmt></BkToCstmrStmt>
        </Document>
        """;

    // ── Default: a leg recorded in the app is confirmed by its statement (rules 8/69/71) ──

    [Fact]
    public async Task ADepartureRecordedInTheApp_IsOfferedToItsStatement_AndMatchingTakesTheBankDate_WithoutMovingMoneyAgain()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Recorded, 100m, a.Id, b.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, SourceStatement, a.Id)).Items.Single();
        var candidate = row.TransferMatches.Single();
        candidate.TransferId.Should().Be(transfer.Id);
        candidate.Kind.Should().Be(TransferMatchKinds.Match);
        candidate.RecordedDate.Should().Be(Recorded);
        candidate.Fee.Should().BeNull();

        var result = await CommitAsync(db, a.Id, Row(row) with { TransferAccountId = b.Id, MatchTransferId = transfer.Id });
        result.MatchedTransfers.Should().Be(1);
        result.Imported.Should().Be(0);

        var stored = await ReloadAsync(db, transfer.Id);
        stored.DepartedOn.Should().Be(Departure, "the bank's posting date replaces the one recorded (rule 69)");
        stored.Date.Should().Be(Departure);
        stored.BankReference.Should().Be(row.Reference);
        (await db.Transactions.CountAsync()).Should().Be(1);
        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(900m, "one departure, not two");
        views[a.Id].InTransitOut.Should().Be(100m);
        views[b.Id].CurrentBalance.Should().Be(200m);

        // Confirmed by the statement, the leg is no longer offered and the row is known.
        var again = await PreviewAsync(db, SourceStatement, a.Id);
        again.SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task AReceiptRecordedInTheApp_IsConfirmedByTheDestinationStatement_OnTheBanksDate()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        // "Move money" with the arrival left at its default, the departure day.
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id, ReceivedOn: Departure), CancellationToken.None);

        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        row.TransferMatches.Single().RecordedDate.Should().Be(Departure);
        await CommitAsync(db, b.Id, Row(row) with { TransferAccountId = a.Id, MatchTransferId = transfer.Id });

        var stored = await ReloadAsync(db, transfer.Id);
        stored.ReceivedOn.Should().Be(Receipt);
        stored.ReceiptBankReference.Should().Be(row.Reference);
        (await AccountsAsOf(db, Departure))[b.Id].CurrentBalance.Should().Be(200m, "the money reached B on the bank's date");
        (await AccountsAsOf(db, Later))[b.Id].CurrentBalance.Should().Be(300m);
    }

    [Fact]
    public async Task AnIncomeAllocationTransfer_IsOfferedToItsStatement_AndKeepsItsAllocationKey()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var allocation = new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.Eur, Date = Recorded,
            DepartedOn = Recorded, Payee = "Income allocation", AccountId = a.Id, TransferAccountId = b.Id,
            AllocationKey = "alloc:2026-9:member",
        };
        db.Transactions.Add(allocation);
        await db.SaveChangesAsync();

        var row = (await PreviewAsync(db, SourceStatement, a.Id)).Items.Single();
        row.TransferMatches.Single().TransferId.Should().Be(allocation.Id);
        await CommitAsync(db, a.Id, Row(row) with { TransferAccountId = b.Id, MatchTransferId = allocation.Id });

        var stored = await ReloadAsync(db, allocation.Id);
        stored.BankReference.Should().Be(row.Reference);
        stored.AllocationKey.Should().Be("alloc:2026-9:member", "a re-run of the allocation still finds its transfer");
    }

    // ── O1 answer 2: a reused bank reference is shown, not skipped ──

    [Fact]
    public async Task AReferenceReusedForADifferentEntry_IsOfferedUnderItsOwnReference_AndReimportingItChangesNothing()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var september = LedgerFixtures.Expense(db, Owner, a.Id, 50m, new DateOnly(2026, 9, 5));
        september.BankReference = "SO-GYM";
        await db.SaveChangesAsync();

        // The same entry again is a duplicate.
        (await PreviewAsync(db, Camt("SO-GYM", new DateOnly(2026, 9, 5), 50m, false), a.Id, StatementFormat.Camt053))
            .SkippedDuplicates.Should().Be(1);

        // October's standing order reuses the reference with another date: shown and flagged.
        var october = Camt("SO-GYM", new DateOnly(2026, 10, 5), 50m, false);
        var row = (await PreviewAsync(db, october, a.Id, StatementFormat.Camt053)).Items.Single();
        row.ReusedReference.Should().Be(new ReusedReference(new DateOnly(2026, 9, 5), 50m, false));
        row.Reference.Should().StartWith("SO-GYM~");

        (await CommitAsync(db, a.Id, Row(row))).Imported.Should().Be(1);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
        (await PreviewAsync(db, october, a.Id, StatementFormat.Camt053)).SkippedDuplicates.Should().Be(1);

        // A commit that echoes the bank's own reference lands under the same derived one: no duplicate.
        (await CommitAsync(db, a.Id, Row(row) with { Reference = "SO-GYM" })).SkippedDuplicates.Should().Be(1);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
    }

    // ── O1 answer 4: a transfer the bank sent back ──

    [Fact]
    public async Task ATransferSentBack_IsConfirmedByTheSourceStatement_AndTheMoneyReturnsToTheJarItLeft()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var holiday = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1000m, Accrual = AccrualMethod.TargetByDate,
            FundingAccountId = a.Id,
        };
        db.Jars.Add(holiday);
        await db.SaveChangesAsync();
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Opening);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id, FromJarId: holiday.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, ReturnStatement, a.Id)).Items.Single();
        var candidate = row.TransferMatches.Single();
        candidate.Kind.Should().Be(TransferMatchKinds.Return);
        candidate.CounterpartyAccountId.Should().Be(b.Id);

        var result = await CommitAsync(db, a.Id, Row(row) with { ReturnOfTransferId = transfer.Id });
        result.Returned.Should().Be(1);
        result.Imported.Should().Be(0);

        var stored = await ReloadAsync(db, transfer.Id);
        stored.ReturnedOn.Should().Be(Returned);
        stored.ReturnBankReference.Should().Be(row.Reference);
        stored.TransferStatus.Should().Be(TransferStatus.Returned);

        var during = await AccountsAsOf(db, Receipt);
        during[a.Id].CurrentBalance.Should().Be(900m);
        during[a.Id].InTransitOut.Should().Be(100m);
        var after = await AccountsAsOf(db, Later);
        after[a.Id].CurrentBalance.Should().Be(1000m);
        after[a.Id].InTransitOut.Should().Be(0m);
        after[b.Id].CurrentBalance.Should().Be(200m);
        after[b.Id].InTransitIn.Should().Be(0m);

        (await JarLedgerReader.ReadAsync(db, Owner, Receipt, CancellationToken.None)).BalanceOf(holiday.Id).Should().Be(300m);
        (await JarLedgerReader.ReadAsync(db, Owner, Later, CancellationToken.None)).BalanceOf(holiday.Id).Should().Be(400m,
            "the money comes back to the jar it left");

        // Returned, it has no receipt to confirm, and the return is known on A's statement.
        (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single().TransferMatches.Should().BeEmpty();
        (await PreviewAsync(db, ReturnStatement, a.Id)).SkippedDuplicates.Should().Be(1);
        await Assert.ThrowsAsync<ValidationException>(() => new ConfirmTransferLegsCommandHandler(db, User)
            .Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: Later), CancellationToken.None));
    }

    [Fact]
    public async Task AReturnMustMatchTheTransferThatLeft_ThisAccount_AndWhoseReceiptNoStatementConfirmed()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var received = await Transfers(db).Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id, ReceivedOn: Receipt), CancellationToken.None);
        await ReceiptConfirmedByStatementAsync(db, received.Id);
        var row = (await PreviewAsync(db, ReturnStatement, a.Id)).Items.Single();
        row.TransferMatches.Should().BeEmpty("B's statement shows the money arrived, so it can't come back");

        var ex = await Assert.ThrowsAsync<ValidationException>(() => CommitAsync(db, a.Id, Row(row) with { ReturnOfTransferId = received.Id }));
        ex.Errors["Items"].Single().Should().Contain("its receipt is confirmed by a statement");
        (await ReloadAsync(db, received.Id)).ReturnedOn.Should().BeNull();
    }

    private static async Task ReceiptConfirmedByStatementAsync(ApplicationDbContext db, Guid transferId)
    {
        var transfer = await db.Transactions.SingleAsync(t => t.Id == transferId);
        transfer.ReceiptBankReference = "B-RECEIPT-1";
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
    }

    // ── O1 answer 5: an explicit transfer fee ──

    [Fact]
    public async Task ALargerDebit_MatchesTheTransfer_OnlyWithTheFeeStated_AndTheFeeIsSpendingOnItsLine()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var (septemberFees, _) = SeedFeeLines(db);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Recorded, 100m, a.Id, b.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, SourceStatementWithFee, a.Id)).Items.Single();
        var candidate = row.TransferMatches.Single();
        candidate.Fee.Should().Be(2m);

        var match = Row(row) with { TransferAccountId = b.Id, MatchTransferId = transfer.Id };
        var refused = await Assert.ThrowsAsync<ValidationException>(() => CommitAsync(db, a.Id, match));
        refused.Errors["Items"].Single().Should().Contain("confirm that fee", "a fee is never inferred (rule 44)");

        await CommitAsync(db, a.Id, match with { Fee = 2m, FeeBudgetItemId = septemberFees.Id });

        var stored = await ReloadAsync(db, transfer.Id);
        stored.Amount.Should().Be(100m);
        stored.DepartedOn.Should().Be(Departure);
        stored.Fee!.Amount.Should().Be(2m);
        stored.Fee.Type.Should().Be(TransactionType.Expense);
        stored.Fee.AccountId.Should().Be(a.Id);
        stored.Fee.Date.Should().Be(Departure);
        stored.Fee.BudgetItemId.Should().Be(septemberFees.Id);
        (await AccountsAsOf(db, Later))[a.Id].CurrentBalance.Should().Be(898m, "A was debited the 102 its statement shows");

        // B's statement then matches the 100 that arrived, and A's row is known.
        var receipt = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();
        receipt.TransferMatches.Single().Fee.Should().BeNull();
        (await PreviewAsync(db, SourceStatementWithFee, a.Id)).SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task ASmallerCredit_MeansAFeeTakenOnTheWay_AndTheSourceStillLosesWhatLeftIt()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Departure, 100m, a.Id, b.Id), CancellationToken.None);

        var row = (await PreviewAsync(db, DestinationStatementLessFee, b.Id)).Items.Single();
        row.TransferMatches.Single().Fee.Should().Be(2m);
        await CommitAsync(db, b.Id, Row(row) with { TransferAccountId = a.Id, MatchTransferId = transfer.Id, Fee = 2m });

        var stored = await ReloadAsync(db, transfer.Id);
        stored.Amount.Should().Be(98m);
        stored.Fee!.Amount.Should().Be(2m);
        stored.Fee.BudgetItemId.Should().BeNull("left uncategorised when no line is chosen");
        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(900m);
        views[b.Id].CurrentBalance.Should().Be(298m);
        views[a.Id].InTransitOut.Should().Be(0m);
    }

    [Fact]
    public async Task ADebitRecordedAsANewTransfer_CanSplitOffItsFee()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var (septemberFees, _) = SeedFeeLines(db);

        var row = (await PreviewAsync(db, SourceStatementWithFee, a.Id)).Items.Single();
        await CommitAsync(db, a.Id, Row(row) with { TransferAccountId = b.Id, Fee = 2m, FeeBudgetItemId = septemberFees.Id });

        var transfer = await db.Transactions.Include(t => t.Fee).SingleAsync(t => t.Type == TransactionType.Transfer);
        transfer.Amount.Should().Be(100m);
        transfer.Fee!.Amount.Should().Be(2m);
        (await AccountsAsOf(db, Later))[a.Id].CurrentBalance.Should().Be(898m);
        (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single().TransferMatches.Single().TransferId.Should().Be(transfer.Id);
    }

    // ── O1 answer 3: a transfer is corrected in place ──

    [Fact]
    public async Task EditingATransfer_ReplacesItsAccountsAmountAndDates_AndChecksEveryAccountItTouches()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var c = SeedAccount(db, "C", 50m);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Recorded, 100m, a.Id, b.Id, ReceivedOn: Receipt), CancellationToken.None);
        var edit = new UpdateTransferCommandHandler(db, User);

        var dto = await edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, c.Id, 120m, Departure, Receipt, Payee: "To C"), CancellationToken.None);
        dto.TransferAccountId.Should().Be(c.Id);
        dto.Amount.Should().Be(120m);
        dto.DepartedOn.Should().Be(Departure);
        var views = await AccountsAsOf(db, Later);
        views[a.Id].CurrentBalance.Should().Be(880m);
        views[b.Id].CurrentBalance.Should().Be(200m);
        views[c.Id].CurrentBalance.Should().Be(170m);

        // C paid 150 out of that money; moving the transfer away from C would leave it short (rule 74).
        LedgerFixtures.Expense(db, Owner, c.Id, 150m, Later);
        var refused = await Assert.ThrowsAsync<ValidationException>(() =>
            edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 120m, Departure, Receipt), CancellationToken.None));
        refused.Errors.Should().ContainKey("Amount");
        (await ReloadAsync(db, transfer.Id)).TransferAccountId.Should().Be(c.Id);
    }

    [Fact]
    public async Task ALegConfirmedByAStatement_KeepsTheBanksAccountDateAndAmount_WhileTheOtherLegCanBeCorrected()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var transfer = await Transfers(db).Handle(new CreateTransferCommand(Recorded, 100m, a.Id, b.Id), CancellationToken.None);
        var row = (await PreviewAsync(db, SourceStatement, a.Id)).Items.Single();
        await CommitAsync(db, a.Id, Row(row) with { TransferAccountId = b.Id, MatchTransferId = transfer.Id });
        var edit = new UpdateTransferCommandHandler(db, User);

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 90m, Recorded, null), CancellationToken.None));
        ex.Errors.Keys.Should().BeEquivalentTo(new[] { "Amount", "DepartedOn" });

        // The receipt is not confirmed by a statement: it can be added and corrected.
        var dto = await edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Departure, Later), CancellationToken.None);
        dto.ReceivedOn.Should().Be(Later);
        dto.DepartureConfirmedByStatement.Should().BeTrue();
        dto.ReceiptConfirmedByStatement.Should().BeFalse();

        // A fee may be added only if what left A stays the 100 its statement shows.
        (await Assert.ThrowsAsync<ValidationException>(() =>
            edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Departure, Later, Fee: 2m), CancellationToken.None)))
            .Errors.Should().ContainKey("Amount");
        var withFee = await edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 98m, Departure, Later, Fee: 2m), CancellationToken.None);
        withFee.Fee.Should().Be(2m);
        (await AccountsAsOf(db, Later))[b.Id].CurrentBalance.Should().Be(298m);
    }

    [Fact]
    public async Task ATransferCanBeMarkedReturned_ByEditing_AndItsFeeGoesWithItWhenDeleted()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var (septemberFees, _) = SeedFeeLines(db);
        var transfer = await Transfers(db).Handle(
            new CreateTransferCommand(Departure, 100m, a.Id, b.Id, Fee: 2m, FeeBudgetItemId: septemberFees.Id), CancellationToken.None);
        transfer.Fee.Should().Be(2m);
        transfer.FeeBudgetItemId.Should().Be(septemberFees.Id);
        var edit = new UpdateTransferCommandHandler(db, User);

        var returned = await edit.Handle(new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Departure, null, Returned,
            Fee: 2m, FeeBudgetItemId: septemberFees.Id), CancellationToken.None);
        returned.TransferStatus.Should().Be(nameof(TransferStatus.Returned));
        returned.ReturnedOn.Should().Be(Returned);
        (await AccountsAsOf(db, Later))[a.Id].CurrentBalance.Should().Be(998m, "the transfer came back; the fee was spent");

        // The fee row is changed only through its transfer.
        var feeId = (await ReloadAsync(db, transfer.Id)).Fee!.Id;
        await Assert.ThrowsAsync<ValidationException>(() =>
            new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(feeId), CancellationToken.None));
        await Assert.ThrowsAsync<ValidationException>(() =>
            new UpdateTransactionCommandHandler(db, User).Handle(
                new UpdateTransactionCommand(feeId, Departure, "Fee", 5m, TransactionType.Expense, a.Id), CancellationToken.None));

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(transfer.Id), CancellationToken.None);
        (await db.Transactions.CountAsync()).Should().Be(0);
        (await AccountsAsOf(db, Later))[a.Id].CurrentBalance.Should().Be(1000m);
    }

    [Fact]
    public async Task ATransferThatWasReceived_CantAlsoBeReturned()
    {
        var validator = new UpdateTransferCommandValidator();
        var id = Guid.NewGuid();
        validator.Validate(new UpdateTransferCommand(id, Guid.NewGuid(), Guid.NewGuid(), 100m, Departure, Receipt, Returned))
            .Errors.Should().Contain(e => e.PropertyName == nameof(UpdateTransferCommand.ReturnedOn));
        validator.Validate(new UpdateTransferCommand(id, Guid.NewGuid(), Guid.NewGuid(), 100m, Departure, null, Recorded))
            .Errors.Should().Contain(e => e.PropertyName == nameof(UpdateTransferCommand.ReturnedOn));
        validator.Validate(new UpdateTransferCommand(id, Guid.NewGuid(), Guid.NewGuid(), 100m, null, Receipt, Fee: 2m))
            .IsValid.Should().BeTrue("the handler refuses the fee without a departure, with its reason");
    }
}
