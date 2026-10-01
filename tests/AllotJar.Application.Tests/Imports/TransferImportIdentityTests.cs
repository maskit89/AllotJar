using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Fix plan C of the end-to-end check (30 September 2026): a transfer's fee can't be refunded
/// (TX-P2-1); a camt.053 entry without a bank reference keeps one identity across imports
/// (TX-P2-2); a reference repeated within a statement keeps one identity across overlapping
/// statements, including rows stored under the old "#N" suffix (TX-P2-3); a commit confirming a
/// recorded transfer needs the statement's account (TX-P2-4); held and skipped rows are named by
/// their position in the request (TX-P3-5).
/// </summary>
public class TransferImportIdentityTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep5 = new(2026, 9, 5);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);
    private static readonly DateOnly Sep20 = new(2026, 9, 20);

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid? accountId) =>
        new PreviewImportCommandHandler(db, User,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), Ct);

    private static Task<ImportStatementResult> CommitAsync(ApplicationDbContext db, Guid? accountId, params CommitImportItem[] items) =>
        new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(accountId, items), Ct);

    private static CommitImportItem Item(ImportCandidate row) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null);

    private static string Camt(params (string? Ref, DateOnly Date, decimal Amount, bool Credit, string Payee)[] rows) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + string.Concat(rows.Select(r =>
            $"<Ntry><Amt Ccy=\"EUR\">{r.Amount:0.00}</Amt><CdtDbtInd>{(r.Credit ? "CRDT" : "DBIT")}</CdtDbtInd><BookgDt><Dt>{r.Date:yyyy-MM-dd}</Dt></BookgDt>"
            + (r.Ref is null ? "" : $"<AcctSvcrRef>{r.Ref}</AcctSvcrRef>")
            + $"<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>{r.Payee}</Nm></Cdtr><Dbtr><Nm>{r.Payee}</Nm></Dbtr></RltdPties></TxDtls></NtryDtls></Ntry>"))
        + "</Stmt></BkToCstmrStmt></Document>";

    private static (string? Ref, DateOnly Date, decimal Amount, bool Credit, string Payee) Row(
        string? reference, DateOnly date, decimal amount, bool credit = false, string payee = "Shop") =>
        (reference, date, amount, credit, payee);

    private static BudgetItem SeedFeeLine(ApplicationDbContext db)
    {
        var fees = new BudgetItem { Name = "Bank fees", PlannedAmount = 10m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { fees } },
            },
        });
        db.SaveChanges();
        return fees;
    }

    // ───────────────────────────── TX-P2-1: refunds on a transfer's fee ─────────────────────────────

    private static async Task<(Account A, Account B, BudgetItem Fees, Guid TransferId, Transaction Refund)> TransferWithLegacyFeeRefundAsync(
        ApplicationDbContext db, decimal fee, decimal refunded)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var fees = SeedFeeLine(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, Fee: fee, FeeBudgetItemId: fees.Id), Ct);
        var feeRow = await db.Transactions.SingleAsync(t => t.FeeForTransferId == transfer.Id);
        // Linked before linking a refund to a fee was refused: written straight to the store.
        var refund = LedgerFixtures.Income(db, Owner, a.Id, refunded, Sep12);
        refund.RefundOfTransactionId = feeRow.Id;
        await db.SaveChangesAsync(Ct);
        db.ChangeTracker.Clear();
        return (a, b, fees, transfer.Id, refund);
    }

    [Fact]
    public async Task LinkingARefundToATransfersFee_IsRefused()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var fees = SeedFeeLine(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, Fee: 2m, FeeBudgetItemId: fees.Id), Ct);
        var feeRow = await db.Transactions.SingleAsync(t => t.FeeForTransferId == transfer.Id);
        var refund = LedgerFixtures.Income(db, Owner, a.Id, 2m, Sep12);

        var act = () => new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(refund.Id, feeRow.Id), Ct);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(m => m).Should().Contain(m => m.Contains("fee can't be refunded"));
    }

    [Fact]
    public async Task DeletingATransfer_WhoseFeeHasARefundLinked_IsRefused()
    {
        await using var db = NewContext();
        var (_, _, _, transferId, _) = await TransferWithLegacyFeeRefundAsync(db, fee: 2m, refunded: 2m);

        var act = () => new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(transferId), Ct);

        await act.Should().ThrowAsync<ValidationException>();
        (await db.Transactions.CountAsync(t => t.Id == transferId || t.FeeForTransferId == transferId)).Should().Be(2);
    }

    [Fact]
    public async Task RemovingTheFee_WhileARefundIsLinkedToIt_IsRefused()
    {
        await using var db = NewContext();
        var (a, b, _, transferId, _) = await TransferWithLegacyFeeRefundAsync(db, fee: 2m, refunded: 2m);

        var act = () => new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transferId, a.Id, b.Id, 100m, Sep10, null, Fee: null), Ct);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task ShrinkingTheFee_BelowItsLinkedRefund_IsRefused_ButNotDownToIt()
    {
        await using var db = NewContext();
        var (a, b, fees, transferId, _) = await TransferWithLegacyFeeRefundAsync(db, fee: 5m, refunded: 3m);

        var below = () => new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transferId, a.Id, b.Id, 100m, Sep10, null, Fee: 1m, FeeBudgetItemId: fees.Id), Ct);
        await below.Should().ThrowAsync<ValidationException>();

        db.ChangeTracker.Clear();
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transferId, a.Id, b.Id, 100m, Sep10, null, Fee: 3m, FeeBudgetItemId: fees.Id), Ct);
        (await db.Transactions.SingleAsync(t => t.FeeForTransferId == transferId)).Amount.Should().Be(3m);
    }

    // ───────────────────────────── TX-P2-2: entries without a bank reference ─────────────────────────────

    [Fact]
    public void Camt053_AnEntryWithoutAReference_GetsAStableContentReference()
    {
        var parser = new Camt053StatementParser();
        var xml = Camt(Row(null, Sep10, 40m), Row(null, Sep10, 40m), Row(null, Sep10, 40m, payee: "Other"));

        var first = parser.Parse(xml).Entries.Select(e => e.Reference).ToList();
        var second = parser.Parse(xml).Entries.Select(e => e.Reference).ToList();

        first.Should().Equal(second, "the same statement always reads the same");
        first.Should().OnlyContain(r => r != null && r.StartsWith("camt:"));
        first.Should().OnlyHaveUniqueItems("two identical card payments are told apart by their order");
        first[0].Should().EndWith("#0");
        first[1].Should().EndWith("#1");
        first[2].Should().EndWith("#0");
    }

    [Fact]
    public async Task AnEntryWithoutAReference_IsNotImportedAgain()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var xml = Camt(Row(null, Sep10, 40m), Row(null, Sep10, 40m));

        var first = await PreviewAsync(db, xml, a.Id);
        first.Items.Should().HaveCount(2);
        first.Items.Select(i => i.Reference).Should().OnlyHaveUniqueItems().And.NotContain(string.Empty);
        (await CommitAsync(db, a.Id, first.Items.Select(Item).ToArray())).Imported.Should().Be(2);

        var second = await PreviewAsync(db, xml, a.Id);
        second.NewCount.Should().Be(0);
        second.SkippedDuplicates.Should().Be(2);
        (await CommitAsync(db, a.Id, first.Items.Select(Item).ToArray())).Imported.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
    }

    // ───────────────────────────── TX-P2-3: a reference repeated within a statement ─────────────────────────────

    [Fact]
    public async Task ARepeatedReference_KeepsOneIdentity_AcrossOverlappingStatements()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);

        var both = await PreviewAsync(db, Camt(Row("SO-1", Sep5, 50m), Row("SO-1", Sep20, 50m)), a.Id);
        both.Items.Should().HaveCount(2);
        both.Items.Select(i => i.Reference).Should().OnlyHaveUniqueItems();
        both.Items.Should().OnlyContain(i => i.ReusedReference == null,
            "a repeat within the statement being imported is not a reference the account already used");
        await CommitAsync(db, a.Id, both.Items.Select(Item).ToArray());

        // A later download from 15 Sep shows only the second row.
        var later = await PreviewAsync(db, Camt(Row("SO-1", Sep20, 50m)), a.Id);
        later.NewCount.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
    }

    [Fact]
    public async Task ARepeatedReference_ImportedFromTheLaterStatementFirst_IsNotImportedAgain()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);

        var later = await PreviewAsync(db, Camt(Row("SO-1", Sep20, 50m)), a.Id);
        await CommitAsync(db, a.Id, later.Items.Select(Item).ToArray());

        var both = await PreviewAsync(db, Camt(Row("SO-1", Sep5, 50m), Row("SO-1", Sep20, 50m)), a.Id);
        both.Items.Should().ContainSingle().Which.Date.Should().Be(Sep5);
        await CommitAsync(db, a.Id, both.Items.Select(Item).ToArray());
        (await PreviewAsync(db, Camt(Row("SO-1", Sep5, 50m), Row("SO-1", Sep20, 50m)), a.Id)).NewCount.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
    }

    [Fact]
    public async Task ARowStoredUnderTheOldOccurrenceSuffix_IsStillRecognised()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        // Imported before this change: the parser stored the second row as "SO-1#1".
        LedgerFixtures.Expense(db, Owner, a.Id, 50m, Sep5).BankReference = "SO-1";
        LedgerFixtures.Expense(db, Owner, a.Id, 50m, Sep20).BankReference = "SO-1#1";
        await db.SaveChangesAsync(Ct);

        (await PreviewAsync(db, Camt(Row("SO-1", Sep20, 50m)), a.Id)).NewCount.Should().Be(0);
        (await PreviewAsync(db, Camt(Row("SO-1", Sep5, 50m), Row("SO-1", Sep20, 50m)), a.Id)).NewCount.Should().Be(0);
        var commit = await CommitAsync(db, a.Id, new CommitImportItem("SO-1", Sep20, "Shop", 50m, "EUR", false, null, null));
        commit.Imported.Should().Be(0);
    }

    // Review of #299, P2-1: the first row of the repeat was never stored (unticked, or held and
    // discarded), so the raw reference is free while the second row sits under its derived one.
    [Fact]
    public async Task ARepeatedReference_WhoseFirstRowWasNeverImported_IsNotImportedAgain()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var oct5 = new DateOnly(2026, 10, 5);

        var both = await PreviewAsync(db, Camt(Row("SO-1", Sep5, 50m), Row("SO-1", Sep20, 50m)), a.Id);
        (await CommitAsync(db, a.Id, Item(both.Items[1]))).Imported.Should().Be(1);

        var later = await PreviewAsync(db, Camt(Row("SO-1", Sep20, 50m), Row("SO-1", oct5, 50m)), a.Id);
        later.Items.Select(i => i.Date).Should().Equal(oct5);
    }

    [Fact]
    public async Task ARowStoredUnderTheOldOccurrenceSuffix_WithoutItsFirstRow_IsStillRecognised()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        LedgerFixtures.Expense(db, Owner, a.Id, 50m, Sep20).BankReference = "SO-1#1";
        await db.SaveChangesAsync(Ct);

        (await PreviewAsync(db, Camt(Row("SO-1", Sep20, 50m)), a.Id)).NewCount.Should().Be(0);
    }

    [Fact]
    public async Task IdenticalRowsUnderOneReference_BothImport_AndReimportChangesNothing()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var xml = Camt(Row("CARD-9", Sep10, 12m), Row("CARD-9", Sep10, 12m));

        var preview = await PreviewAsync(db, xml, a.Id);
        preview.Items.Select(i => i.Reference).Should().Equal("CARD-9", "CARD-9#1");
        await CommitAsync(db, a.Id, preview.Items.Select(Item).ToArray());

        (await PreviewAsync(db, xml, a.Id)).NewCount.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.AccountId == a.Id)).Should().Be(2);
    }

    // ───────────────────────────── TX-P2-4: a match needs the statement's account ─────────────────────────────

    [Fact]
    public async Task ConfirmingARecordedTransfer_WithoutAnAccount_IsRefused()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id), Ct);
        var item = new CommitImportItem("X-1", Sep10, "Transfer", 100m, "EUR", false, null, null, MatchTransferId: transfer.Id);

        new CommitImportCommandValidator().Validate(new CommitImportCommand(null, [item])).IsValid.Should().BeFalse();
        var act = () => CommitAsync(db, null, item);
        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("AccountId");
    }

    // ───────────────────────────── TX-P3-5: rows named by position ─────────────────────────────

    [Fact]
    public async Task HeldAndSkippedRows_AreNamedByTheirPositionInTheRequest()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 100m, Sep1, AccountType.Current);
        LedgerFixtures.Expense(db, Owner, a.Id, 10m, Sep5).BankReference = "OLD";
        await db.SaveChangesAsync(Ct);

        var result = await CommitAsync(db, a.Id,
            new CommitImportItem("NEW-1", Sep10, "Shop", 20m, "EUR", false, null, null),
            new CommitImportItem("OLD", Sep5, "Shop", 10m, "EUR", false, null, null),
            new CommitImportItem("BIG", Sep12, "Shop", 500m, "EUR", false, null, null));

        result.SkippedIndexes.Should().Equal(1);
        result.Held.Should().ContainSingle().Which.Index.Should().Be(2);
        result.Imported.Should().Be(1);
    }
}
