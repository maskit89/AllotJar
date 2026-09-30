using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit.Abstractions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Tests.TestDoubles;
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
/// Regressions from the adversarial review of W07 (round 1 at 6070119, round 2 at 1f182dc,
/// round 3 at 6e776a3, round 4 at 3233809): each test is the reviewer's probe and failed on that head.
/// </summary>
public class TransferIdentityW07ReviewTests(ITestOutputHelper output)
{
    private sealed class UserStub(string userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private sealed class Viewer(string userId, string owner) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => owner;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId => null;
    }

    private const string Owner = "user-1";
    private static readonly UserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);
    private static readonly DateOnly Sep15 = new(2026, 9, 15);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);

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

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, ICurrentUser user, string content, Guid accountId) =>
        new PreviewImportCommandHandler(db, user,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), Ct);

    private static string Camt(string reference, DateOnly date, decimal amount, bool credit, string payee = "Gym Ltd") => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
          <BkToCstmrStmt><Stmt><Id>S</Id>
            <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
            <Ntry>
              <Amt Ccy="EUR">{amount:0.00}</Amt>
              <CdtDbtInd>{(credit ? "CRDT" : "DBIT")}</CdtDbtInd>
              <BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt>
              <AcctSvcrRef>{reference}</AcctSvcrRef>
              <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>{payee}</Nm></Cdtr></RltdPties></TxDtls></NtryDtls>
            </Ntry>
          </Stmt></BkToCstmrStmt>
        </Document>
        """;

    // A jar funds a transfer; the bank sends it back; the user then empties the jar (the returned
    // money included) and archives it. The return is attributed as of the day it came back, so a
    // later archive rewrites neither today nor that day (P1-2).
    [Fact]
    public async Task ReturnedMoney_IsNotReattributed_WhenTheJarIsArchivedLater()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);

        (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).BalanceOf(holiday.Id).Should().Be(400m);

        // The user moves all 400 out of the jar and archives it (rule 26: only at zero).
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Sep15, JarAllocationKind.Reallocation);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        var after = await JarLedgerReader.ReadAsync(db, Owner, Today, Ct);
        var view = after.Accounts[a.Id];
        output.WriteLine($"today: A={view.AccountBalance} unallocated={view.Unallocated} holiday={view.JarBalances.GetValueOrDefault(holiday.Id)}");
        var past = await JarLedgerReader.ReadAsync(db, Owner, Sep12, Ct);
        output.WriteLine($"as of 12 Sep (read after the archive): holiday={past.Accounts[a.Id].JarBalances.GetValueOrDefault(holiday.Id)} unallocated={past.Accounts[a.Id].Unallocated}");

        view.AccountBalance.Should().Be(1000m);
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, "the jar was archived at zero");
        view.Unallocated.Should().Be(1000m, "unallocated can't exceed what the jars don't hold");
        past.Accounts[a.Id].JarBalances.GetValueOrDefault(holiday.Id).Should().Be(400m, "archiving later must not rewrite 12 September");
    }

    // Same, with the jar moved to another account after the return (rule 80 departure).
    [Fact]
    public async Task ReturnedMoney_IsNotReattributed_WhenTheJarMovesToAnotherAccountLater()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, AccountType.Savings, order: 2);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);

        // Moving a jar needs it empty on A first (the returned 100 included).
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Sep15, JarAllocationKind.Reallocation);
        try
        {
            await new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
                holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, c.Id), Ct);
        }
        catch (AllotJar.Application.Common.Exceptions.ValidationException ex)
        {
            output.WriteLine("move refused: " + string.Join(" | ", ex.Errors.SelectMany(e => e.Value)));
            throw;
        }

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"A after the move: balance={view.AccountBalance} unallocated={view.Unallocated} holiday-on-A={view.JarBalances.GetValueOrDefault(holiday.Id)}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, "the jar was emptied on A before it moved");
        view.Unallocated.Should().Be(1000m);
    }

    // Sam moves money from the joint account into Sam's private savings (recorded in the app, no
    // statement reference). Chris previews the joint account's statement: the candidate names the
    // hidden side "Private account" instead of failing (P1-1, P57).
    [Fact]
    public async Task JointStatementPreview_DoesNotCrash_OnATransferIntoAnotherLoginsPrivateAccount()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"w07-privacy-{Guid.NewGuid()}").Options;
        const string chris = Owner, sam = "sam-login";
        Guid joint, samSavings;
        await using (var seed = new ApplicationDbContext(options))
        {
            joint = LedgerFixtures.SeedAccount(seed, Owner, "Joint", 2000m, Sep1, AccountType.Current).Id;
            samSavings = LedgerFixtures.SeedAccount(seed, Owner, "Sam's savings", 0m, Sep1, AccountType.Savings, order: 1).Id;
            seed.AccountPrivacies.Add(new AccountPrivacy { AccountId = samSavings, UserId = sam });
            seed.Transactions.Add(new Transaction
            {
                OwnerId = Owner, Type = TransactionType.Transfer, AccountId = joint, TransferAccountId = samSavings,
                Amount = 300m, Currency = CurrencyCode.Eur, Date = Sep10, DepartedOn = Sep10, ReceivedOn = Sep10, Payee = "Move money",
            });
            await seed.SaveChangesAsync();
        }

        var chrisView = new Viewer(chris, Owner);
        await using var db = new ApplicationDbContext(options, chrisView);
        var rent = Camt("RENT-OCT", Sep15, 1100m, false, "Landlord");
        var act = () => PreviewAsync(db, chrisView, rent, joint);
        var preview = await act.Should().NotThrowAsync("a hidden counterparty must not break the joint statement's preview");
        output.WriteLine($"candidates on the rent row: {preview.Subject.Items.Single().TransferMatches.Count}");
    }

    // Chris confirms the joint account's side of Sam's transfer without ever receiving the private
    // account's id: the candidate names "Private account" and the match names only the transfer.
    [Fact]
    public async Task AJointStatementConfirmsItsSideOfATransferToAPrivateAccount_WithoutItsId()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"w07-privacy-{Guid.NewGuid()}").Options;
        Guid joint, samSavings, transferId;
        await using (var seed = new ApplicationDbContext(options))
        {
            joint = LedgerFixtures.SeedAccount(seed, Owner, "Joint", 2000m, Sep1, AccountType.Current).Id;
            samSavings = LedgerFixtures.SeedAccount(seed, Owner, "Sam's savings", 0m, Sep1, AccountType.Savings, order: 1).Id;
            seed.AccountPrivacies.Add(new AccountPrivacy { AccountId = samSavings, UserId = "sam-login" });
            var transfer = new Transaction
            {
                OwnerId = Owner, Type = TransactionType.Transfer, AccountId = joint, TransferAccountId = samSavings,
                Amount = 300m, Currency = CurrencyCode.Eur, Date = Sep10, DepartedOn = Sep10, ReceivedOn = Sep10, Payee = "Move money",
            };
            seed.Transactions.Add(transfer);
            await seed.SaveChangesAsync();
            transferId = transfer.Id;
        }

        var chrisView = new Viewer(Owner, Owner);
        await using var db = new ApplicationDbContext(options, chrisView);
        var row = (await PreviewAsync(db, chrisView, Camt("JOINT-1", Sep10, 300m, false, "To Sam"), joint)).Items.Single();
        var candidate = row.TransferMatches.Should().ContainSingle().Subject;
        candidate.CounterpartyAccountId.Should().BeNull();
        candidate.CounterpartyAccountName.Should().Be("Private account");

        var item = new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null,
            MatchTransferId: transferId);
        new CommitImportCommandValidator().Validate(new CommitImportCommand(joint, new[] { item })).IsValid.Should().BeTrue();
        var result = await new CommitImportCommandHandler(db, chrisView)
            .Handle(new CommitImportCommand(joint, new[] { item }), Ct);

        result.Transfers.Should().Be(1);
        db.ChangeTracker.Clear();
        var stored = await db.Transactions.IgnoreQueryFilters().SingleAsync(t => t.Id == transferId);
        stored.BankReference.Should().Be("JOINT-1");
        stored.ReceivedOn.Should().Be(Sep10, "the private side is its holder's to change");
    }

    // Rule 91: a fee confirmed at import names its line; a changed fee's candidate carries the
    // line the current fee is on so the review can pre-fill it (P2-8).
    [Fact]
    public async Task AFeeConfirmedAtImport_NeedsItsLine_AndTheCandidateCarriesTheCurrentOne()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Savings, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id), Ct);
        var fees = new BudgetItem { Name = "Bank fees", PlannedAmount = 10m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Charges", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { fees } } },
        });
        await db.SaveChangesAsync();
        var line = fees.Id;
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Type = TransactionType.Expense, AccountId = a.Id, Amount = 1m, Currency = CurrencyCode.Eur,
            Date = Sep10, Payee = "Fee: Transfer", FeeForTransferId = transfer.Id, BudgetItemId = line,
        });
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var row = (await PreviewAsync(db, User, Camt("A-FEE-1", Sep10, 102m, false, "To B"), a.Id)).Items.Single();
        var candidate = row.TransferMatches.Should().ContainSingle().Subject;
        candidate.Fee.Should().Be(2m);
        candidate.FeeBudgetItemId.Should().Be(line);
        // ... and that line's month, so the review asks the cross-month question the commit would (#286 P2-1).
        candidate.FeeBudgetItemMonth.Should().Be(Sep1);

        var item = new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null,
            TransferAccountId: b.Id, MatchTransferId: transfer.Id, Fee: 2m);
        var result = new CommitImportCommandValidator().Validate(new CommitImportCommand(a.Id, new[] { item }));
        result.Errors.Should().ContainSingle(e => e.ErrorMessage == "Choose the budget line the transfer's fee is spent from.");
    }

    // Rule 88: correcting an imported row's date (or amount) keeps what the bank printed, so the
    // next import of the same statement still skips that row (P2-1).
    [Fact]
    public async Task ReimportingAStatement_AfterCorrectingAnImportedRow_StillSkipsIt()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var statement = Camt("CARD-777", Sep10, 42.50m, false, "Cafe");
        var row = (await PreviewAsync(db, User, statement, a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(
            new CommitImportCommand(a.Id, new[] { new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null) }), Ct);
        var stored = await db.Transactions.SingleAsync();

        // The user moves it to the day the purchase was actually made.
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(stored.Id, new DateOnly(2026, 9, 9), "Cafe", 42.50m, TransactionType.Expense, a.Id), Ct);

        var again = await PreviewAsync(db, User, statement, a.Id);
        output.WriteLine($"skipped={again.SkippedDuplicates} offered={again.Items.Count} reused={again.Items.FirstOrDefault()?.ReusedReference}");
        again.SkippedDuplicates.Should().Be(1, "it is the same bank entry the account already holds");
    }

    // A fee is proposed only while small against the transfer: a rent debit is not last month's
    // transfer with a huge "fee" (P3-1).
    [Fact]
    public async Task ARentDebit_IsNotOfferedAsAnOldTransferWithAHugeFee()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 5000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Savings, order: 1);
        await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, ReceivedOn: Sep10), Ct);
        var row = (await PreviewAsync(db, User, Camt("RENT", Sep15, 1100m, false, "Landlord"), a.Id)).Items.Single();
        output.WriteLine($"rent row candidates: {string.Join(", ", row.TransferMatches.Select(m => $"{m.Amount} fee {m.Fee}"))}");
        row.TransferMatches.Should().BeEmpty("a 1,100 rent payment is not a 100 transfer with a 1,000 fee");
    }

    // "Move money" records the arrival on the departure day (an app guess, not a bank date). When
    // the source statement moves the departure later, the guessed arrival follows it (P2-2).
    [Fact]
    public async Task MatchingALaterBankDeparture_DoesNotLeaveTheGuessedReceiptBeforeIt()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Savings, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, ReceivedOn: Sep10), Ct);
        var row = (await PreviewAsync(db, User, Camt("TRF-1", Sep12, 100m, false, "To savings"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null,
                TransferAccountId: b.Id, MatchTransferId: transfer.Id),
        }), Ct);

        db.ChangeTracker.Clear();
        var stored = await db.Transactions.SingleAsync();
        var accounts = (await new AllotJar.Application.Accounts.Queries.GetAccounts.GetAccountsQueryHandler(db, User)
            .Handle(new AllotJar.Application.Accounts.Queries.GetAccounts.GetAccountsQuery(new DateOnly(2026, 9, 11)), Ct)).ToDictionary(x => x.Id);
        output.WriteLine($"departed {stored.DepartedOn} received {stored.ReceivedOn}; 11 Sep: A={accounts[a.Id].CurrentBalance} B={accounts[b.Id].CurrentBalance}");
        (accounts[a.Id].CurrentBalance + accounts[b.Id].CurrentBalance).Should().Be(1200m, "the 100 can't be in both accounts on 11 September");
    }

    // A return confirmed by A's statement keeps the account and amount A's bank credited (P2-3).
    [Fact]
    public async Task AStatementConfirmedReturn_KeepsItsAccountAndAmount()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Savings, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 1000m, Sep1, AccountType.Current, order: 2);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id), Ct);
        var row = (await PreviewAsync(db, User, Camt("RET-1", Sep12, 100m, true, "Returned"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, true, null, null, ReturnOfTransferId: transfer.Id),
        }), Ct);

        var edit = () => new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, c.Id, b.Id, 60m, Sep10, null, Sep12), Ct);
        await edit.Should().ThrowAsync<AllotJar.Application.Common.Exceptions.ValidationException>(
            "A's statement shows 100 coming back to A; the return can't move to C or become 60");
        db.ChangeTracker.Clear();
        (await PreviewAsync(db, User, Camt("RET-1", Sep12, 100m, true, "Returned"), a.Id)).SkippedDuplicates.Should().Be(1);
    }

    // Rule 90: a statement credit on the source confirms a return, also for a "Move money" transfer
    // whose arrival the app only guessed (P2-4).
    [Fact]
    public async Task TheSourceStatementsReturnCredit_IsOffered_ForATransferWhoseArrivalWasOnlyGuessed()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Savings, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, ReceivedOn: Sep10), Ct);
        var row = (await PreviewAsync(db, User, Camt("RET-9", Sep12, 100m, true, "Returned payment"), a.Id)).Items.Single();
        output.WriteLine($"return candidates: {row.TransferMatches.Count(m => m.Kind == TransferMatchKinds.Return)}");
        row.TransferMatches.Should().Contain(m => m.TransferId == transfer.Id && m.Kind == TransferMatchKinds.Return);
    }

    // Round 2. A return's jar postings are stored when it is recorded, so the jar's later archive,
    // move or restore changes nothing it already read (R2-P1-1, R2-P2-1, R2-P2-2).
    [Fact]
    public async Task RestoringAnArchivedJar_DoesNotPullAnEarlierReturnBackIntoIt()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 100m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        // Holiday is empty after the transfer and was archived on 11 September.
        holiday.IsArchived = true;
        holiday.ArchivedOn = new DateOnly(2026, 9, 11);
        await db.SaveChangesAsync();
        var back = (await PreviewAsync(db, User, Camt("RET-7", Sep12, 100m, true, "Returned"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(back.Reference, back.Date, back.Payee, back.Amount, back.Currency, true, null, null, ReturnOfTransferId: transfer.Id),
        }), Ct);

        var before = (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).Accounts[a.Id];
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id, Archived: false), Ct);
        var after = (await JarLedgerReader.ReadAsync(db, Owner, Sep15, Ct)).Accounts[a.Id];
        output.WriteLine($"15 Sep: archived holiday={before.JarBalances.GetValueOrDefault(holiday.Id)}, restored holiday={after.JarBalances.GetValueOrDefault(holiday.Id)} unallocated={after.Unallocated}");

        before.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m);
        after.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, "restoring a jar today can't change what it held on 15 September");
        after.Unallocated.Should().Be(1000m);
    }

    [Fact]
    public async Task ArchivingOnTheReturnDay_AfterTheReturn_KeepsTheJarAtZero()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Today, FromJarId: holiday.Id), Ct);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).BalanceOf(holiday.Id).Should().Be(400m);

        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Today, JarAllocationKind.Reallocation);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"same-day archive: holiday={view.JarBalances.GetValueOrDefault(holiday.Id)} unallocated={view.Unallocated} A={view.AccountBalance}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m);
        view.Unallocated.Should().Be(1000m);
    }

    [Fact]
    public async Task MovingTheJarOnTheReturnDay_AfterTheReturn_LeavesNothingOfItOnTheOldAccount()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, AccountType.Savings, order: 2);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Today, FromJarId: holiday.Id), Ct);

        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Today, JarAllocationKind.Reallocation);
        await new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, c.Id), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"same-day move: holiday-on-A={view.JarBalances.GetValueOrDefault(holiday.Id)} unallocated={view.Unallocated} A={view.AccountBalance}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m);
        view.Unallocated.Should().Be(1000m);
    }

    [Fact]
    public async Task AReturnImportedAfterTheJarWasArchived_DoesNotLeaveMoneyInTheArchivedJar()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 100m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        var back = (await PreviewAsync(db, User, Camt("RET-8", Sep12, 100m, true, "Returned"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(back.Reference, back.Date, back.Payee, back.Amount, back.Currency, true, null, null, ReturnOfTransferId: transfer.Id),
        }), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"archived jar after the late return: holiday={view.JarBalances.GetValueOrDefault(holiday.Id)} unallocated={view.Unallocated} A={view.AccountBalance}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, "an archived jar holds nothing (rule 26)");
        view.Unallocated.Should().Be(1000m);
    }

    // Rule 74 on the other account is judged against every row the import already accepted, not
    // the database alone (R2-P2-3).
    [Fact]
    public async Task TwoMatchesInOneImport_CantTogetherTakeTheOtherAccountBelowZero()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Savings, order: 1);
        var t1 = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, ReceivedOn: Sep10), Ct);
        var t2 = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, ReceivedOn: Sep10), Ct);
        LedgerFixtures.Expense(db, Owner, b.Id, 50m, new DateOnly(2026, 9, 11));

        var statement = """
            <?xml version="1.0" encoding="UTF-8"?>
            <Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
              <BkToCstmrStmt><Stmt><Id>S</Id>
                <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
                <Ntry><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-12</Dt></BookgDt><AcctSvcrRef>T-1</AcctSvcrRef></Ntry>
                <Ntry><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2026-09-12</Dt></BookgDt><AcctSvcrRef>T-2</AcctSvcrRef></Ntry>
              </Stmt></BkToCstmrStmt>
            </Document>
            """;
        var rows = (await PreviewAsync(db, User, statement, a.Id)).Items;
        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(rows[0].Reference, rows[0].Date, rows[0].Payee, rows[0].Amount, rows[0].Currency, false, null, null, TransferAccountId: b.Id, MatchTransferId: t1.Id),
            new CommitImportItem(rows[1].Reference, rows[1].Date, rows[1].Payee, rows[1].Amount, rows[1].Currency, false, null, null, TransferAccountId: b.Id, MatchTransferId: t2.Id),
        }), Ct);

        db.ChangeTracker.Clear();
        var bOn11 = (await new AllotJar.Application.Accounts.Queries.GetAccounts.GetAccountsQueryHandler(db, User)
            .Handle(new AllotJar.Application.Accounts.Queries.GetAccounts.GetAccountsQuery(new DateOnly(2026, 9, 11)), Ct)).Single(x => x.Id == b.Id).CurrentBalance;
        output.WriteLine($"matched={result.MatchedTransfers} held={result.HeldCount}; B on 11 Sep = {bOn11}");
        result.MatchedTransfers.Should().Be(1);
        result.HeldCount.Should().Be(1);
        bOn11.Should().Be(50m, "rule 74: the second match would leave B below zero on 11 September");
    }

    // Christopher, 29 September: a fee is offered up to the larger of 10% of the transfer and 10,
    // so a bank's fixed charge on a small transfer is still offered (R2-D1).
    [Fact]
    public async Task ASmallTransferWithAFixedBankFee_IsStillOffered()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 20m, a.Id, b.Id), Ct);

        var within = (await PreviewAsync(db, User, Camt("INTL-1", Sep10, 30m, false, "International transfer"), a.Id)).Items.Single();
        var beyond = (await PreviewAsync(db, User, Camt("INTL-2", Sep10, 30.01m, false, "International transfer"), a.Id)).Items.Single();

        within.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id && m.Fee == 10m);
        beyond.TransferMatches.Should().BeEmpty("a 10.01 fee is more than both 10 and 10% of 20");
    }

    // Rule 87: every candidate is listed nearest date first, a fee candidate included; an exact
    // amount only breaks a tie on the date.
    [Fact]
    public async Task Candidates_AreListedNearestDateFirst_WhetherOrNotTheyNeedAFee()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        var farExact = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep1, 100m, a.Id, b.Id, ReceivedOn: Sep1), Ct);
        var nearWithFee = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep12, 98m, a.Id, b.Id, ReceivedOn: Sep12), Ct);
        var sameDayExact = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep12, 100m, a.Id, b.Id, ReceivedOn: Sep12), Ct);

        var row = (await PreviewAsync(db, User, Camt("T-9", Sep12, 100m, false, "Transfer"), a.Id)).Items.Single();

        row.TransferMatches.Select(m => m.TransferId).Should().Equal(sameDayExact.Id, nearWithFee.Id, farExact.Id);
    }

    // Round 3. A statement confirming a return the user already marked by hand keeps the jar
    // decision made then and only takes the bank's date: the jar, since emptied and archived,
    // isn't handed the money a second time (R3-P1-1).
    [Fact]
    public async Task ConfirmingAHandMarkedReturnAfterTheJarWasArchived_KeepsTheJarAtZero()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Today, JarAllocationKind.Reallocation);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(holiday.Id), Ct);

        // The bank printed the credit a day later than the user marked it.
        var back = (await PreviewAsync(db, User, Camt("RET-9", new DateOnly(2026, 9, 13), 100m, true, "Returned"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(back.Reference, back.Date, back.Payee, back.Amount, back.Currency, true, null, null, ReturnOfTransferId: transfer.Id),
        }), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"after the statement confirmed the return: holiday={view.JarBalances.GetValueOrDefault(holiday.Id)} unallocated={view.Unallocated} A={view.AccountBalance}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(0m, "confirming a return changes nothing about where the money went (rule 26)");
        view.Unallocated.Should().Be(1000m);
        var onThe13th = (await JarLedgerReader.ReadAsync(db, Owner, new DateOnly(2026, 9, 13), Ct)).Accounts[a.Id];
        var onThe12th = (await JarLedgerReader.ReadAsync(db, Owner, Sep12, Ct)).Accounts[a.Id];
        onThe13th.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(400m, "the jar has its share back from the bank's date");
        onThe12th.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(300m, "the money was still away on 12 September");
    }

    [Theory]
    [InlineData(20, 30, true)]
    [InlineData(20, 30.01, false)]
    [InlineData(1000, 1100, true)]
    [InlineData(1000, 1100.01, false)]
    public async Task TheFeeBound_IsTheLargerOfTenPercentAndTen(decimal sent, decimal debit, bool offered)
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 5000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 0m, Sep1, AccountType.Current, order: 1);
        await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, sent, a.Id, b.Id), Ct);
        var row = (await PreviewAsync(db, User, Camt("F-1", Sep10, debit, false, "Transfer"), a.Id)).Items.Single();
        (row.TransferMatches.Count > 0).Should().Be(offered);
    }

    // Rule 87: nearest date first, even over a candidate carrying the row's bank reference, which
    // is badged instead (round 3's candidate order).
    [Fact]
    public async Task ACandidateWithTheSameBankReference_IsBadged_NotListedAboveANearerOne()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 1000m, Sep1, AccountType.Current, order: 1);
        var far = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep1, 100m, a.Id, b.Id), Ct);
        var farRow = await db.Transactions.SingleAsync(t => t.Id == far.Id);
        farRow.BankReference = "SHARED-1";
        await db.SaveChangesAsync();
        var near = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(new DateOnly(2026, 9, 11), 100m, a.Id, b.Id), Ct);

        var row = (await PreviewAsync(db, User, Camt("SHARED-1", Sep12, 100m, true, "Transfer"), b.Id)).Items.Single();

        row.TransferMatches.Select(m => m.TransferId).Should().Equal(near.Id, far.Id);
        row.TransferMatches.Single(m => m.TransferId == far.Id).SameReference.Should().BeTrue();
    }

    // Round 4. A statement often shows a bounced transfer leaving and coming back: one import
    // confirms both legs (R4-P2-1), and when the departure turns out to have been paid from
    // another jar, the return goes back to that jar (R4-P2-2).
    private static string Camt2(params (string Ref, DateOnly Date, decimal Amount, bool Credit)[] rows) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + string.Concat(rows.Select(r => $"<Ntry><Amt Ccy=\"EUR\">{r.Amount:0.00}</Amt><CdtDbtInd>{(r.Credit ? "CRDT" : "DBIT")}</CdtDbtInd><BookgDt><Dt>{r.Date:yyyy-MM-dd}</Dt></BookgDt><AcctSvcrRef>{r.Ref}</AcctSvcrRef></Ntry>"))
        + "</Stmt></BkToCstmrStmt></Document>";

    private static CommitImportItem Item(ImportCandidate row, bool credit, Guid? match = null, Guid? paidFrom = null, Guid? returnOf = null) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, credit, null, null,
            MatchTransferId: match, PaidFromJarId: paidFrom, ReturnOfTransferId: returnOf);

    private static async Task<(Account A, Account B, Jar Holiday, Jar Car, Guid TransferId)> SeedHolidayAndCarAsync(ApplicationDbContext db)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var holiday = SeedGoal(db, a);
        var car = SeedGoal(db, a, "Car");
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        LedgerFixtures.Allocate(db, Owner, a.Id, car.Id, 400m, Sep1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        return (a, b, holiday, car, t.Id);
    }

    [Fact]
    public async Task OneStatementWithTheDepartureAndTheReturn_ImportsBoth()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(Sep10, 100m, a.Id, b.Id), Ct);
        var rows = (await PreviewAsync(db, User, Camt2(("D-5", Sep10, 100m, false), ("R-5", Sep12, 100m, true)), a.Id)).Items;

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            Item(rows[0], false, match: t.Id),
            Item(rows[1], true, returnOf: t.Id),
        }), Ct);

        result.MatchedTransfers.Should().Be(1);
        result.Returned.Should().Be(1);
        var stored = await db.Transactions.SingleAsync(x => x.Id == t.Id);
        (stored.BankReference, stored.DepartedOn, stored.ReturnBankReference, stored.ReturnedOn)
            .Should().Be(("D-5", Sep10, "R-5", Sep12));

        // Neither leg can be confirmed twice.
        var again = (await PreviewAsync(db, User, Camt2(("D-6", Sep10, 100m, false)), a.Id)).Items.Single();
        again.TransferMatches.Should().NotContain(m => m.TransferId == t.Id);
    }

    [Fact]
    public async Task ADepartureMatchedToAnotherJar_AfterAHandMarkedReturn_InOneStatement_MovesTheReturnToo()
    {
        await using var db = NewContext();
        var (a, b, holiday, car, t) = await SeedHolidayAndCarAsync(db);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(t, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);

        var rows = (await PreviewAsync(db, User, Camt2(("D-1", Sep10, 100m, false), ("R-1", Sep12, 100m, true)), a.Id)).Items;
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            Item(rows[0], false, match: t, paidFrom: car.Id),
            Item(rows[1], true, returnOf: t),
        }), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"holiday={view.JarBalances.GetValueOrDefault(holiday.Id)} car={view.JarBalances.GetValueOrDefault(car.Id)} unallocated={view.Unallocated}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(400m, "Holiday lost nothing: the departure was paid from Car");
        view.JarBalances.GetValueOrDefault(car.Id).Should().Be(400m, "Car's 100 came back");
    }

    [Fact]
    public async Task ADepartureMatchedToAnotherJar_AfterAConfirmedReturn_MovesTheReturnToo()
    {
        await using var db = NewContext();
        var (a, _, holiday, car, t) = await SeedHolidayAndCarAsync(db);
        var back = (await PreviewAsync(db, User, Camt2(("R-2", Sep12, 100m, true)), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(
            new CommitImportCommand(a.Id, new[] { Item(back, true, returnOf: t) }), Ct);

        var departure = (await PreviewAsync(db, User, Camt2(("D-2", Sep10, 100m, false)), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(
            new CommitImportCommand(a.Id, new[] { Item(departure, false, match: t, paidFrom: car.Id) }), Ct);

        var view = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id];
        output.WriteLine($"holiday={view.JarBalances.GetValueOrDefault(holiday.Id)} car={view.JarBalances.GetValueOrDefault(car.Id)} unallocated={view.Unallocated}");
        view.JarBalances.GetValueOrDefault(holiday.Id).Should().Be(400m);
        view.JarBalances.GetValueOrDefault(car.Id).Should().Be(400m);
    }

    // Merged with #276: its startup backfill settles a jar's postings in an account it moved away
    // from before departures were recorded. A stored Return operation (no transaction; dated the
    // return) is ordinary jar history there: the departure settles what it gave back, dated on it.
    [Fact]
    public async Task TheJarDepartureBackfill_SettlesAReturnsShare_OnTheReturnDay()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, AccountType.Savings, order: 2);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 100m, Sep1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        var back = (await PreviewAsync(db, User, Camt("RET-11", Sep12, 100m, true, "Returned"), a.Id)).Items.Single();
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(back.Reference, back.Date, back.Payee, back.Amount, back.Currency, true, null, null, ReturnOfTransferId: transfer.Id),
        }), Ct);
        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(0, "the jar is still in A");

        // A move made before departures were recorded: nothing was written down.
        holiday.FundingAccountId = c.Id;
        await db.SaveChangesAsync();
        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(1);

        async Task<decimal> HolidayInA(DateOnly on) =>
            (await JarLedgerReader.ReadAsync(db, Owner, on, Ct)).Accounts[a.Id].JarBalances.GetValueOrDefault(holiday.Id);
        (await HolidayInA(new DateOnly(2026, 9, 11))).Should().Be(0m);
        (await HolidayInA(Sep12)).Should().Be(0m, "the departure is dated the return, the last day A touched the jar");
        (await HolidayInA(Sep15)).Should().Be(0m);
        var departure = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(Sep12);
        departure.Postings.Should().ContainSingle(p => p.JarId == holiday.Id && p.Amount == -100m);
        (await JarDepartures.BackfillAsync(db, Ct)).Departures.Should().Be(0);
    }

    // Second merge pass on #279 (M2-P2-1): a Return operation's jar share is settled on the jar's
    // departure (#276, rule 80) whenever the return changes after the jar left the account, like
    // every other jar share. Holiday 400 on A pays a 100 transfer on 10 Sep; the bounce is marked
    // by hand on 12 Sep; the user empties Holiday on 15 Sep and moves it to C today.
    private static async Task<(Account A, Account B, Jar Holiday, Guid TransferId)> SeedMovedAfterAReturnAsync(ApplicationDbContext db)
    {
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", 200m, Sep1, AccountType.Current, order: 1);
        var c = LedgerFixtures.SeedAccount(db, Owner, "C", 0m, Sep1, AccountType.Savings, order: 2);
        var holiday = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, 400m, Sep1);
        var t = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Sep10, 100m, a.Id, b.Id, FromJarId: holiday.Id), Ct);
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(t.Id, a.Id, b.Id, 100m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, a.Id, holiday.Id, -400m, Sep15, JarAllocationKind.Reallocation);
        await new UpdateJarCommandHandler(db, User).Handle(new UpdateJarCommand(
            holiday.Id, "Holiday", JarKind.Goal, 1200m, holiday.TargetDate, AccrualMethod.TargetByDate, c.Id), Ct);
        (await db.JarAllocations.CountAsync(x => x.Kind == JarAllocationKind.Departure)).Should().Be(1);
        (await HolidayAsync(db, a, holiday, Today)).InA.Should().Be(0m);
        return (a, b, holiday, t.Id);
    }

    private static async Task<(decimal InA, decimal? Total)> HolidayAsync(ApplicationDbContext db, Account a, Jar holiday, DateOnly on)
    {
        var snapshot = await JarLedgerReader.ReadAsync(db, Owner, on, Ct);
        return (snapshot.Accounts[a.Id].JarBalances.GetValueOrDefault(holiday.Id), snapshot.BalanceOf(holiday.Id));
    }

    // Moves are dated today in the app; these tests date the move 13 Sep so a return can fall after it.
    private static async Task DateTheMoveAsync(ApplicationDbContext db, DateOnly on)
    {
        foreach (var op in await db.JarAllocations.Where(x => x.Kind == JarAllocationKind.Departure || x.Kind == JarAllocationKind.Reallocation).ToListAsync())
        {
            op.Date = on;
        }
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task UndoingAReturn_AfterTheJarMoved_LeavesNothingInTheOldAccount()
    {
        await using var db = NewContext();
        var (a, b, holiday, id) = await SeedMovedAfterAReturnAsync(db);

        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(id, a.Id, b.Id, 100m, Sep10, null, null, FromJarId: holiday.Id), Ct);

        (await HolidayAsync(db, a, holiday, Today)).Should().Be((0m, 0m));
    }

    [Fact]
    public async Task DeletingAReturnedTransfer_AfterTheJarMoved_LeavesNothingInTheOldAccount()
    {
        await using var db = NewContext();
        var (a, _, holiday, id) = await SeedMovedAfterAReturnAsync(db);

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(id), Ct);

        (await HolidayAsync(db, a, holiday, Today)).Should().Be((0m, 0m));
    }

    [Fact]
    public async Task ChangingAReturnedTransfersAmount_AfterTheJarMoved_LeavesNothingInTheOldAccount()
    {
        await using var db = NewContext();
        var (a, b, holiday, id) = await SeedMovedAfterAReturnAsync(db);

        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(id, a.Id, b.Id, 80m, Sep10, null, Sep12, FromJarId: holiday.Id), Ct);

        (await HolidayAsync(db, a, holiday, Today)).Should().Be((0m, 0m));
    }

    [Fact]
    public async Task RetypingAReturnedTransfer_AfterTheJarMoved_LeavesNothingInTheOldAccount()
    {
        await using var db = NewContext();
        var (a, _, holiday, id) = await SeedMovedAfterAReturnAsync(db);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(id, Sep10, "Card", 100m, TransactionType.Expense, a.Id), Ct);

        (await HolidayAsync(db, a, holiday, Today)).Should().Be((0m, 0m));
    }

    // A date the user types can't move the jar's share past the day the jar left (rule 80), as for
    // any entry of the jar's stretch in that account.
    [Fact]
    public async Task RedatingAReturnByHand_PastTheDayItsJarLeft_IsRefused()
    {
        await using var db = NewContext();
        var (a, b, holiday, id) = await SeedMovedAfterAReturnAsync(db);
        await DateTheMoveAsync(db, new DateOnly(2026, 9, 13));

        var act = () => new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(id, a.Id, b.Id, 100m, Sep10, null, Sep15, FromJarId: holiday.Id), Ct);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("ReturnedOn");
        (await db.JarAllocations.SingleAsync(x => x.Kind == JarAllocationKind.Return)).Date.Should().Be(Sep12);
        foreach (var day in new[] { new DateOnly(2026, 9, 13), new DateOnly(2026, 9, 14), Sep15 })
        {
            (await HolidayAsync(db, a, holiday, day)).InA.Should().Be(0m, $"Holiday left A on 13 Sep ({day})");
        }
    }

    // The bank's date is a fact, not a choice: a statement dating the return after the jar left
    // decides the return again as of that date, when the jar wasn't there, so the money comes back
    // unallocated and what the hand-marked return gave the jar is settled on its departure.
    [Fact]
    public async Task AStatementDatingAReturnAfterItsJarLeft_DecidesItAgain_Unallocated()
    {
        await using var db = NewContext();
        var (a, _, holiday, id) = await SeedMovedAfterAReturnAsync(db);
        await DateTheMoveAsync(db, new DateOnly(2026, 9, 13));
        var unallocated = (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated;

        var back = (await PreviewAsync(db, User, Camt("RET-20", Sep15, 100m, true, "Returned"), a.Id)).Items.Single();
        back.TransferMatches.Should().Contain(m => m.TransferId == id && m.Kind == TransferMatchKinds.Return);
        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(a.Id, new[]
        {
            new CommitImportItem(back.Reference, back.Date, back.Payee, back.Amount, back.Currency, true, null, null, ReturnOfTransferId: id),
        }), Ct);

        (await db.Transactions.SingleAsync(t => t.Id == id)).ReturnedOn.Should().Be(Sep15);
        (await db.JarAllocations.Include(x => x.Postings).Where(x => x.Kind == JarAllocationKind.Return).ToListAsync())
            .SelectMany(x => x.Postings).Should().NotContain(p => p.JarId == holiday.Id);
        foreach (var day in new[] { new DateOnly(2026, 9, 13), new DateOnly(2026, 9, 14), Sep15, Today })
        {
            (await HolidayAsync(db, a, holiday, day)).InA.Should().Be(0m, $"Holiday left A on 13 Sep ({day})");
        }
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[a.Id].Unallocated.Should().Be(unallocated);
    }
}
