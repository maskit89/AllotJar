using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using Xunit.Abstractions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Regressions from the adversarial review of W07 (round 1, at 6070119): each test is the
/// reviewer's probe and failed on that head.
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

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"w07-review-{Guid.NewGuid()}").Options);

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
        var result = await new CommitImportCommandHandler(db, chrisView, new FakeExchangeRateProvider())
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
        await new CommitImportCommandHandler(db, User, new FakeExchangeRateProvider()).Handle(
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
        await new CommitImportCommandHandler(db, User, new FakeExchangeRateProvider()).Handle(new CommitImportCommand(a.Id, new[]
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
        await new CommitImportCommandHandler(db, User, new FakeExchangeRateProvider()).Handle(new CommitImportCommand(a.Id, new[]
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
}
