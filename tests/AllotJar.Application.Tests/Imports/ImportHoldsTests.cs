using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Rule 74 on an imported statement: the statement account is evaluated row by row in date order
/// against its stored money plus the rows accepted so far. A debit that would take it below zero
/// on any date is returned in <c>Held</c> with the reason and is not posted; the later rows are
/// judged without it. Credits, and transfer receipts still pending review, are never held. A held
/// row is resolved by recording the missing deposit and re-committing it.
/// </summary>
public class ImportHoldsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly DateOnly June1 = new(2026, 6, 1);
    private static readonly DateOnly June3 = new(2026, 6, 3);
    private static readonly DateOnly June5 = new(2026, 6, 5);
    private static readonly DateOnly June10 = new(2026, 6, 10);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-import-holds-{Guid.NewGuid()}")
            .Options);

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db) =>
        new(db, User);

    private static CommitImportItem Debit(string reference, DateOnly date, decimal amount, Guid? transferAccountId = null) =>
        new(reference, date, "CARD PAYMENT " + reference, amount, "EUR", IsCredit: false, null, null, TransferAccountId: transferAccountId);

    private static CommitImportItem Credit(string reference, DateOnly date, decimal amount, Guid? transferAccountId = null) =>
        new(reference, date, "RECEIPT " + reference, amount, "EUR", IsCredit: true, null, null, TransferAccountId: transferAccountId);

    private static Task<List<string?>> StoredReferencesAsync(ApplicationDbContext db) =>
        db.Transactions.AsNoTracking().Select(t => t.BankReference ?? t.ReceiptBankReference).ToListAsync();

    [Fact]
    public async Task CommitImport_HoldsTheDebitThatWouldOverdraw_InDateOrder_AndImportsTheRowsThatFit()
    {
        // Current opens at 100. Supplied out of order; by date: +30 (3 June → 130), −120 (5 June →
        // 10, fits), −100 (10 June → −90, held). Evaluated in the supplied order instead, the 5
        // June debit would be the one held — so the held reference proves the ordering.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);

        var result = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[]
        {
            Debit("D2", June10, 100m),
            Credit("C1", June3, 30m),
            Debit("D1", June5, 120m),
        }), CancellationToken.None);

        result.TotalEntries.Should().Be(3);
        result.Imported.Should().Be(2);
        result.Credits.Should().Be(1);
        result.Debits.Should().Be(1);
        result.SkippedDuplicates.Should().Be(0);
        result.HeldCount.Should().Be(1);
        var held = result.Held.Should().ContainSingle().Subject;
        held.Reference.Should().Be("D2");
        held.Message.Should().Contain("Current would be -90.00 EUR on 2026-06-10");

        (await StoredReferencesAsync(db)).Should().BeEquivalentTo(new[] { "C1", "D1" }, "the held row is not posted");
        (await db.Transactions.CountAsync()).Should().Be(2);
    }

    [Fact]
    public async Task CommitImport_JudgesASameDayDebitOnTheDaysClosingBalance_CreditsFirst()
    {
        // Rule 74 on end-of-day balances: the debit listed before the same-day salary still fits,
        // because the day closes at 100 - 150 + 200 = 150.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);

        var result = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[]
        {
            Debit("D1", June5, 150m),
            Credit("C1", June5, 200m),
        }), CancellationToken.None);

        result.Imported.Should().Be(2);
        result.HeldCount.Should().Be(0);
        (await StoredReferencesAsync(db)).Should().BeEquivalentTo(new[] { "D1", "C1" });
    }

    [Fact]
    public async Task CommitImport_ALaterDebitThatOnlyFitsBecauseTheHeldRowWasNotPosted_IsImported()
    {
        // 100 opening: −150 on 5 June is held; −80 on 10 June fits (100 − 80 = 20) precisely
        // because the held row does not count against the later rows.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);

        var result = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[]
        {
            Debit("D1", June5, 150m),
            Debit("D2", June10, 80m),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.Debits.Should().Be(1);
        result.HeldCount.Should().Be(1);
        result.Held.Single().Reference.Should().Be("D1");
        result.Held.Single().Message.Should().Contain("-50.00").And.Contain("2026-06-05");
        (await StoredReferencesAsync(db)).Should().BeEquivalentTo(new[] { "D2" });
    }

    [Fact]
    public async Task CommitImport_NeverHoldsACredit()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 0m, type: AccountType.Current);

        var result = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[]
        {
            Credit("C1", June3, 500m),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.Credits.Should().Be(1);
        result.Debits.Should().Be(0);
        result.HeldCount.Should().Be(0);
        result.Held.Should().BeEmpty();
        (await db.Transactions.SingleAsync()).Type.Should().Be(TransactionType.Income);
    }

    [Fact]
    public async Task CommitImport_NeverHoldsAnUnmatchedCreditTransferRow_ButItIsNotMoneyForLaterDebits()
    {
        // Rule 72: a receipt whose departure is unknown is recorded for review, never held (it
        // posts nothing); a later debit cannot spend it and is held instead.
        await using var db = NewContext();
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current);
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m, type: AccountType.Current, order: 1);

        var result = await NewCommit(db).Handle(new CommitImportCommand(b.Id, new[]
        {
            Credit("R1", June1, 100m, transferAccountId: a.Id),
            Debit("D1", June5, 50m),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.Transfers.Should().Be(1);
        result.PendingReviewTransfers.Should().Be(1);
        result.Debits.Should().Be(0);
        result.HeldCount.Should().Be(1);
        result.Held.Single().Reference.Should().Be("D1");
        result.Held.Single().Message.Should().Contain("B would be -50.00").And.Contain("2026-06-05");

        var pending = await db.Transactions.SingleAsync();
        pending.Type.Should().Be(TransactionType.Transfer);
        pending.TransferStatus.Should().Be(TransferStatus.PendingReview);
        pending.ReceiptBankReference.Should().Be("R1");
    }

    [Fact]
    public async Task CommitImport_HoldsADebitTransferRow_ThatWouldOverdrawTheStatementAccount()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 100m, type: AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 0m, type: AccountType.Current, order: 1);

        var result = await NewCommit(db).Handle(new CommitImportCommand(a.Id, new[]
        {
            Debit("T1", June5, 150m, transferAccountId: b.Id),
        }), CancellationToken.None);

        result.Imported.Should().Be(0);
        result.Transfers.Should().Be(0);
        result.HeldCount.Should().Be(1);
        result.Held.Single().Reference.Should().Be("T1");
        result.Held.Single().Message.Should().Contain("A would be -50.00").And.Contain("2026-06-05");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task CommitImport_ReCommittingTheHeldRow_AfterTheIncomeIsRecorded_ImportsIt()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", opening: 100m, type: AccountType.Current);
        var row = Debit("D1", June5, 150m);

        var first = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[] { row }), CancellationToken.None);
        first.HeldCount.Should().Be(1);
        first.Imported.Should().Be(0);
        (await db.Transactions.CountAsync()).Should().Be(0);

        // The user records the deposit the statement was missing, then re-applies the held row.
        LedgerFixtures.Income(db, Owner, account.Id, 100m, June1);

        var second = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[] { row }), CancellationToken.None);

        second.HeldCount.Should().Be(0);
        second.Imported.Should().Be(1);
        second.Debits.Should().Be(1);
        second.SkippedDuplicates.Should().Be(0, "a held row was never stored, so it is not a duplicate");
        var imported = await db.Transactions.AsNoTracking().SingleAsync(t => t.BankReference == "D1");
        imported.Amount.Should().Be(150m);
        imported.AccountId.Should().Be(account.Id);

        // A third commit of the same row is now a duplicate, not a second posting.
        var third = await NewCommit(db).Handle(new CommitImportCommand(account.Id, new[] { row }), CancellationToken.None);
        third.SkippedDuplicates.Should().Be(1);
        third.Imported.Should().Be(0);
        (await db.Transactions.CountAsync(t => t.BankReference == "D1")).Should().Be(1);
    }

    [Fact]
    public async Task CommitImport_WithoutAnImportAccount_HoldsNothing()
    {
        await using var db = NewContext();

        var result = await NewCommit(db).Handle(new CommitImportCommand(null, new[]
        {
            Debit("D1", June5, 10_000m),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.HeldCount.Should().Be(0);
        (await db.Transactions.SingleAsync()).AccountId.Should().BeNull();
    }
}
