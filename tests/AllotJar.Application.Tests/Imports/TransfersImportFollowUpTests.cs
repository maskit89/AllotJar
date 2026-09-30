using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// The follow-up pass on transfers and the import (30 September 2026): #279 P3-3 (a receipt
/// confirmed by hand is confirmed, not skipped, by a destination statement that prints the
/// source's reference), P3-6 (a fee following its departure into another month meets the
/// cross-month question), R3-P3-1 (the reader checks a Return operation against its transfer),
/// R4-P3-1 "Keep" (a return re-dated past its jar's archive keeps the jar's share at the day it
/// was marked), R3-P3-2 "10% only" (no flat fee floor) and the rule 80 in-transit check reading
/// every account the jar has history in.
/// </summary>
public class TransfersImportFollowUpTests
{
    private sealed class UserStub(string userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";
    private static readonly UserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);
    private static readonly DateOnly Sep13 = new(2026, 9, 13);
    private static readonly DateOnly Sep14 = new(2026, 9, 14);
    private static readonly DateOnly Sep15 = new(2026, 9, 15);
    private static readonly DateOnly Sep29 = new(2026, 9, 29);
    private static readonly DateOnly Oct2 = new(2026, 10, 2);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"followup-transfers-{Guid.NewGuid()}").Options);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m, TargetDate = new DateOnly(Today.Year + 1, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid accountId) =>
        new PreviewImportCommandHandler(db, User,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), Ct);

    private static Task<ImportStatementResult> CommitAsync(ApplicationDbContext db, Guid accountId, params CommitImportItem[] items) =>
        new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(accountId, items), Ct);

    private static string Camt(params (string Ref, DateOnly Date, decimal Amount, bool Credit)[] rows) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + string.Concat(rows.Select(r => $"<Ntry><Amt Ccy=\"EUR\">{r.Amount:0.00}</Amt><CdtDbtInd>{(r.Credit ? "CRDT" : "DBIT")}</CdtDbtInd><BookgDt><Dt>{r.Date:yyyy-MM-dd}</Dt></BookgDt><AcctSvcrRef>{r.Ref}</AcctSvcrRef></Ntry>"))
        + "</Stmt></BkToCstmrStmt></Document>";

    private static CommitImportItem Item(ImportCandidate row, Guid? match = null, Guid? returnOf = null, Guid? counterparty = null,
        decimal? fee = null, Guid? feeLine = null, bool acknowledge = false) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null,
            TransferAccountId: counterparty, MatchTransferId: match, ReturnOfTransferId: returnOf,
            Fee: fee, FeeBudgetItemId: feeLine, AcknowledgeCrossMonth: acknowledge);

    private static async Task<Transaction> ReloadAsync(ApplicationDbContext db, Guid id)
    {
        db.ChangeTracker.Clear();
        return await db.Transactions.Include(t => t.Fee).SingleAsync(t => t.Id == id);
    }

    /// <summary>September 2026 with a "Bank fees" expense line.</summary>
    private static BudgetItem SeedFeeLine(ApplicationDbContext db, int month = 9)
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

    // ── #279 P3-3: both banks print one reference ──

    [Fact]
    public async Task ADestinationStatementPrintingTheSourcesReference_ConfirmsAReceiptMarkedByHand_InsteadOfSkippingIt()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id), Ct);

        // A's statement confirms the departure under SHARED-1; the user then marks the receipt by hand.
        var debit = (await PreviewAsync(db, Camt(("SHARED-1", Sep10, 100m, false)), a.Id)).Items.Single();
        await CommitAsync(db, a.Id, Item(debit, match: transfer.Id, counterparty: b.Id));
        await new ConfirmTransferLegsCommandHandler(db, User).Handle(new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: Sep12), Ct);
        (await ReloadAsync(db, transfer.Id)).ReceiptKnownBySourceReference.Should().BeFalse("a receipt confirmed by hand has no reference of its own");

        // B's bank prints the same reference: the row is offered as this transfer's receipt, flagged, not skipped.
        var preview = await PreviewAsync(db, Camt(("SHARED-1", Sep12, 100m, true)), b.Id);
        preview.SkippedDuplicates.Should().Be(0);
        var credit = preview.Items.Single();
        var candidate = credit.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id).Subject;
        candidate.SameReference.Should().BeTrue();

        await CommitAsync(db, b.Id, Item(credit, match: transfer.Id, counterparty: a.Id));
        var stored = await ReloadAsync(db, transfer.Id);
        (stored.BankReference, stored.ReceiptBankReference, stored.ReceivedOn).Should().Be(("SHARED-1", "SHARED-1", Sep12));

        // Importing either statement again changes nothing (rule 51).
        (await PreviewAsync(db, Camt(("SHARED-1", Sep12, 100m, true)), b.Id)).SkippedDuplicates.Should().Be(1);
        (await PreviewAsync(db, Camt(("SHARED-1", Sep10, 100m, false)), a.Id)).SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task ARowFromBeforeReceiptReferences_IsStillKnownToTheDestination_ByItsSourceReference()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        // As the migration leaves such a row: received, source reference only, marked.
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Transfer, Date = Sep10, DepartedOn = Sep10, ReceivedOn = Sep10, Amount = 100m,
            Currency = CurrencyCode.Eur, AccountId = a.Id, TransferAccountId = b.Id, Payee = "Old transfer",
            BankReference = "LEGACY-1", ReceiptKnownBySourceReference = true,
        });
        await db.SaveChangesAsync();

        var preview = await PreviewAsync(db, Camt(("LEGACY-1", Sep10, 100m, true)), b.Id);
        preview.SkippedDuplicates.Should().Be(1, "the destination's statement was what recorded that row");
        preview.Items.Should().BeEmpty();
    }

    // ── #279 P3-6: a fee following its departure into another month ──

    [Fact]
    public async Task AFeeFollowingALaterBankDeparture_IntoAnotherMonth_MeetsTheCrossMonthQuestion()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var september = SeedFeeLine(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep29, 100m, a.Id, b.Id, Fee: 2m, FeeBudgetItemId: september.Id), Ct);

        // The bank posted the 102 on 2 October: the fee's line is September's.
        var row = (await PreviewAsync(db, Camt(("D-OCT", Oct2, 102m, false)), a.Id)).Items.Single();
        row.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id && m.Fee == null, "the recorded fee explains the 102 already");

        var refused = await Assert.ThrowsAsync<ValidationException>(() => CommitAsync(db, a.Id, Item(row, match: transfer.Id, counterparty: b.Id)));
        refused.Errors.Should().ContainKey(TransactionInvariants.CrossMonthKey);
        (await ReloadAsync(db, transfer.Id)).Fee!.Date.Should().Be(Sep29, "nothing moved");

        await CommitAsync(db, a.Id, Item(row, match: transfer.Id, counterparty: b.Id, acknowledge: true));
        var stored = await ReloadAsync(db, transfer.Id);
        stored.DepartedOn.Should().Be(Oct2);
        stored.Fee!.Date.Should().Be(Oct2);
        stored.Fee.BudgetItemId.Should().Be(september.Id, "the user chose to budget it to September");
    }

    [Fact]
    public async Task AFeeFollowingALaterBankDeparture_WithinItsMonth_AsksNothing()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var september = SeedFeeLine(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, Fee: 2m, FeeBudgetItemId: september.Id), Ct);

        var row = (await PreviewAsync(db, Camt(("D-SEP", Sep12, 102m, false)), a.Id)).Items.Single();
        await CommitAsync(db, a.Id, Item(row, match: transfer.Id, counterparty: b.Id));
        (await ReloadAsync(db, transfer.Id)).Fee!.Date.Should().Be(Sep12);
    }

    // ── R3-P3-2 "10% only" (Christopher, 30 September 2026) ──

    [Fact]
    public async Task AFeeIsProposedOnlyUpToTenPercentOfTheTransfer_WithNoFlatFloor()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 20m, a.Id, b.Id), Ct);

        var within = (await PreviewAsync(db, Camt(("INTL-1", Sep10, 22m, false)), a.Id)).Items.Single();
        var beyond = (await PreviewAsync(db, Camt(("INTL-2", Sep10, 22.01m, false)), a.Id)).Items.Single();
        var fixedCharge = (await PreviewAsync(db, Camt(("INTL-3", Sep10, 30m, false)), a.Id)).Items.Single();

        within.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id && m.Fee == 2m);
        beyond.TransferMatches.Should().BeEmpty("2.01 is more than 10% of 20");
        fixedCharge.TransferMatches.Should().BeEmpty("a fixed charge of 10 on a 20 transfer is entered by hand, not proposed");

        // On the receiving side the same share applies to what arrived.
        var arrived = (await PreviewAsync(db, Camt(("IN-1", Sep12, 18.5m, true)), b.Id)).Items.Single();
        arrived.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id && m.Fee == 1.5m, "1.5 is within 10% of the 18.50 that arrived");
        var tooLittle = (await PreviewAsync(db, Camt(("IN-2", Sep12, 17m, true)), b.Id)).Items.Single();
        tooLittle.TransferMatches.Should().BeEmpty("3 is more than 10% of the 17 that arrived");
    }

    // ── R4-P3-1 "Keep" (Christopher, 30 September 2026) ──

    // Holiday funds a 100 transfer on 10 Sep; the user marks it returned on 12 Sep, empties Holiday
    // the same day and archives it on 13 Sep. A's statement then dates the return 15 Sep. The jar's
    // share of the return stays on 12 Sep, so Holiday reads zero on the archive day and after;
    // the account's money comes back on the bank's date.
    [Fact]
    public async Task AReturnTheBankDatesAfterItsJarsArchive_KeepsTheJarsShare_AtTheHandMarkedDate()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(t.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Sep12, JarAllocationKind.Reallocation);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);
        holiday.ArchivedOn = Sep13;
        await db.SaveChangesAsync();

        var back = (await PreviewAsync(db, Camt(("R-3", Sep15, 100m, true)), a.Id)).Items.Single();
        await CommitAsync(db, a.Id, Item(back, returnOf: t.Id));

        var op = await db.JarAllocations.Include(o => o.Postings).SingleAsync(o => o.ReturnOfTransferId == t.Id);
        op.Date.Should().Be(Sep12, "the jar's share stays where the user marked it");
        op.Postings.Should().Contain(p => p.JarId == holiday.Id && p.Amount == 100m);
        (await ReloadAsync(db, t.Id)).ReturnedOn.Should().Be(Sep15, "the bank's date is the return's date");

        foreach (var day in new[] { Sep13, Sep14, Sep15, Today })
        {
            var view = (await JarLedgerReader.ReadAsync(db, Owner, day, Ct)).Accounts[a.Id];
            view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, $"Holiday was emptied and archived before {day}");
            view.UnreconciledAllocations.Should().Be(0, "a share kept at an earlier date is a return the reader honours");
        }
        var sep14 = (await JarLedgerReader.ReadAsync(db, Owner, Sep14, Ct)).Accounts[a.Id];
        sep14.AccountBalance.Should().Be(900m, "the money is back only on the bank's date");
        sep14.Unallocated.Should().Be(900m);
        var sep15 = (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).Accounts[a.Id];
        sep15.AccountBalance.Should().Be(1000m);
        sep15.Unallocated.Should().Be(1000m);
    }

    // ── R3-P3-1: the reader checks a Return operation against its transfer ──

    [Fact]
    public async Task AReturnOperation_WhoseTransferIsNoLongerReturned_IsSetAside_NotApplied()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(t.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);
        (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).BalanceOf(holiday.Id).Should().Be(400m);

        // Every writer keeps the operation in step; a stray row that doesn't is not trusted.
        var stored = await db.Transactions.SingleAsync(x => x.Id == t.Id);
        stored.ReturnedOn = null;
        await db.SaveChangesAsync();

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).Accounts[a.Id];
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(300m, "the transfer is in transit again, so nothing came back");
        view.UnreconciledAllocations.Should().Be(1);
    }

    [Fact]
    public async Task AReturnOperation_DatedAfterItsTransfersReturn_IsSetAside()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(t.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);
        var op = await db.JarAllocations.SingleAsync(o => o.ReturnOfTransferId == t.Id);
        op.Date = Sep15;
        await db.SaveChangesAsync();

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(300m);
        view.Unallocated.Should().Be(700m, "the returned 100 stays unallocated");
        view.UnreconciledAllocations.Should().Be(1);
    }

    // ── Rule 80's in-transit clause reads every account the jar has history in ──

    [Fact]
    public async Task AJarCannotChangeAccount_WhileATransferInTransit_NamesIt_InAnAccountItHasLeft()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 1000m, Sep1, AccountType.Savings, order: 1);
        var d = LedgerFixtures.SeedAccount(db, Owner, "D", 0m, Sep1, AccountType.Savings, order: 2);
        var e = LedgerFixtures.SeedAccount(db, Owner, "E", 0m, Sep1, AccountType.Savings, order: 3);
        var holiday = SeedGoal(db, a);
        // Holiday held nothing in A and moved to D on 10 September.
        await new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, d.Id), Ct);
        // A transfer from C into A, receipt unknown, whose stored jar split still names Holiday on A.
        var t = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep12, 100m, c.Id, a.Id), Ct);
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = a.Id, TransactionId = t.Id, Kind = JarAllocationKind.Movement, Date = Sep12, CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = holiday.Id, Amount = 100m } },
        });
        await db.SaveChangesAsync();

        var act = () => new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, e.Id), Ct);
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["FundingAccountId"].Single()
            .Should().Contain("in transit");
        (await db.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).FundingAccountId.Should().Be(d.Id);
    }
}
