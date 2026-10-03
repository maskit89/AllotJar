using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Common;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Transactions;

/// <summary>
/// PR #306 review round 1: the follow-ups D1, D8, D9 and D10 reached through a neighbouring path.
/// A transfer's receipt is income to its jars (D10); a row moved into another login's private
/// account is still its statement's entry (D8); a purchase with refunds linked can't move to
/// another line (D9); the pocket-money amount is whole cents (D1). Each test is a review probe
/// turned round to assert the fixed behaviour.
/// </summary>
public class MoneyImportFollowUpsReviewTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep5 = new(2026, 9, 5);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);
    private static readonly DateOnly Sep12 = new(2026, 9, 12);

    private sealed class Viewer(string userId, string owner) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => owner;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId => null;
    }

    private static (Account Savings, Jar Holiday, Jar Car) SeedJars(ApplicationDbContext db)
    {
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 0m, Sep1);
        Jar Goal(string name) => new()
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m,
            TargetDate = new DateOnly(2027, 7, 1), Accrual = AccrualMethod.TargetByDate, FundingAccountId = savings.Id,
        };
        var holiday = Goal("Holiday");
        var car = Goal("Car");
        db.Jars.AddRange(holiday, car);
        db.SaveChanges();
        return (savings, holiday, car);
    }

    // --- D10 through a transfer edit (P2-1, P3-2) -----------------------------------------------

    private static async Task<(Account Main, Account Savings, Jar Holiday, Transaction Transfer)> TransferIntoJarThatMovedOnAsync(ApplicationDbContext db)
    {
        var main = LedgerFixtures.SeedAccount(db, Owner, "Main", 1000m, Sep1, AccountType.Current, order: 1);
        var (savings, holiday, car) = SeedJars(db);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(new CreateTransferCommand(
            Sep5, 500m, main.Id, savings.Id, ReceivedOn: Sep5,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 500m, Sep10), Ct);
        db.ChangeTracker.Clear();
        var stored = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == transfer.Id);
        return (main, savings, holiday, stored);
    }

    [Fact]
    public async Task D10_LoweringATransferWhoseReceiptFundedJarsThatMovedOn_IsSaved_WithAWarningNamingTheDeficit()
    {
        await using var db = NewContext();
        var (main, savings, holiday, transfer) = await TransferIntoJarThatMovedOnAsync(db);

        var lowered = await new UpdateTransferCommandHandler(db, User).Handle(new UpdateTransferCommand(
            transfer.Id, main.Id, savings.Id, 200m, Sep5, Sep5,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 200m) }), Ct);

        lowered.Amount.Should().Be(200m, "the edit stands (D10: save, then warn)");
        var ledger = (await JarLedgerReader.ReadAsync(db, Owner, Sep12, Ct)).Accounts[savings.Id];
        ledger.HasBackingDeficit.Should().BeTrue();
        lowered.Warning.Should().StartWith("Saved.").And.Contain("Savings").And.Contain("300");
    }

    [Fact]
    public async Task D10_RePointingSuchATransferToAnotherAccount_WarnsForTheAccountItLeft()
    {
        await using var db = NewContext();
        var (main, savings, _, transfer) = await TransferIntoJarThatMovedOnAsync(db);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Other", 0m, Sep1, AccountType.Current, order: 2);

        var moved = await new UpdateTransferCommandHandler(db, User).Handle(new UpdateTransferCommand(
            transfer.Id, main.Id, other.Id, 500m, Sep5, Sep5), Ct);

        moved.Warning.Should().StartWith("Saved.").And.Contain("Savings");
    }

    [Fact]
    public async Task D10_ATransferEditThatLeavesTheMoneyWhereAndWhenItWas_HasNoWarning()
    {
        await using var db = NewContext();
        var (main, savings, holiday, transfer) = await TransferIntoJarThatMovedOnAsync(db);

        var renamed = await new UpdateTransferCommandHandler(db, User).Handle(new UpdateTransferCommand(
            transfer.Id, main.Id, savings.Id, 500m, Sep5, Sep5, Payee: "Top up",
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);

        renamed.Payee.Should().Be("Top up");
        renamed.Warning.Should().BeNull();
    }

    [Fact]
    public async Task D10_AnEditThatOnlyReAnswersTheJars_IsStillChecked()
    {
        // 500 received unallocated, then spent from unallocated; re-answering the income into a jar
        // moves no money but leaves the jar holding what the account no longer has.
        await using var db = NewContext();
        var (savings, holiday, _) = SeedJars(db);
        var income = await new CreateTransactionCommandHandler(db, User).Handle(new CreateTransactionCommand(
            Sep5, "Employer", 500m, TransactionType.Income, null, savings.Id), Ct);
        LedgerFixtures.Expense(db, Owner, savings.Id, 500m, Sep10);
        db.ChangeTracker.Clear();

        var reAnswered = await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            income.Id, Sep5, "Employer", 500m, TransactionType.Income, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        reAnswered.Warning.Should().StartWith("Saved.").And.Contain("Savings");

        // Saved again exactly as stored, with a new payee: nothing to check, nothing new to say.
        db.ChangeTracker.Clear();
        var renamed = await new UpdateTransactionCommandHandler(db, User).Handle(new UpdateTransactionCommand(
            income.Id, Sep5, "Payroll", 500m, TransactionType.Income, savings.Id,
            JarAllocations: new[] { new JarAllocationInput(holiday.Id, 500m) }), Ct);
        renamed.Payee.Should().Be("Payroll");
        renamed.Warning.Should().BeNull();
    }

    // --- D8 past the privacy filter (P2-2) ------------------------------------------------------

    private static string Camt(string reference, DateOnly date, decimal amount) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + $"<Ntry><Amt Ccy=\"EUR\">{amount:0.00}</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt>"
        + $"<AcctSvcrRef>{reference}</AcctSvcrRef>"
        + "<NtryDtls><TxDtls><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RltdPties><Cdtr><Nm>Shop</Nm></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>"
        + "</Stmt></BkToCstmrStmt></Document>";

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, ICurrentUser user, string content, Guid accountId) =>
        new PreviewImportCommandHandler(db, user,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(content, StatementFormat.Camt053, AccountId: accountId), Ct);

    [Fact]
    public async Task D8_ARowMovedFromTheJointAccountIntoAnotherLoginsPrivateOne_IsStillSkippedForEveryLogin()
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"pr306-d8-{Guid.NewGuid()}").Options;
        const string sam = "sam-login";
        Guid joint, samSavings;
        await using (var seed = new ApplicationDbContext(options))
        {
            joint = LedgerFixtures.SeedAccount(seed, Owner, "Joint", 1000m, Sep1, AccountType.Current).Id;
            samSavings = LedgerFixtures.SeedAccount(seed, Owner, "Sam's savings", 1000m, Sep1, AccountType.Savings, order: 1).Id;
            seed.AccountPrivacies.Add(new AccountPrivacy { AccountId = samSavings, UserId = sam });
            await seed.SaveChangesAsync();
        }
        var xml = Camt("M-1", Sep10, 40m);
        var chris = new Viewer(Owner, Owner);
        await using (var db = new ApplicationDbContext(options, chris))
        {
            var preview = await PreviewAsync(db, chris, xml, joint);
            await new CommitImportCommandHandler(db, chris).Handle(new CommitImportCommand(joint, new[]
            {
                new CommitImportItem(preview.Items[0].Reference, Sep10, "Shop", 40m, preview.Items[0].Currency, false, null, null),
            }), Ct);
        }
        var samView = new Viewer(sam, Owner);
        await using (var db = new ApplicationDbContext(options, samView))
        {
            var row = await db.Transactions.AsNoTracking().SingleAsync(t => t.BankReference == "M-1");
            await new UpdateTransactionCommandHandler(db, samView).Handle(
                new UpdateTransactionCommand(row.Id, Sep10, "Shop", 40m, TransactionType.Expense, samSavings), Ct);
            (await PreviewAsync(db, samView, xml, joint)).NewCount.Should().Be(0);
        }
        await using (var db = new ApplicationDbContext(options, chris))
        {
            (await db.Transactions.AnyAsync(t => t.BankReference == "M-1")).Should().BeFalse("the row stays private to Sam");
            var again = await PreviewAsync(db, chris, xml, joint);
            again.NewCount.Should().Be(0, "the joint statement still knows its entry");
            again.SkippedDuplicates.Should().Be(1);
            again.Items.Should().BeEmpty("nothing about the private row reaches Chris but the skip");

            // A commit shares the same reading: the debit is not posted on the joint account again.
            await new CommitImportCommandHandler(db, chris).Handle(new CommitImportCommand(joint, new[]
            {
                new CommitImportItem("M-1", Sep10, "Shop", 40m, "EUR", false, null, null),
            }), Ct);
        }
        await using (var owner = new ApplicationDbContext(options))
        {
            (await owner.Transactions.CountAsync(t => t.BankReference == "M-1")).Should().Be(1);
        }
    }

    // --- D9 through a whole-row reassignment (P2-3) ---------------------------------------------

    [Fact]
    public async Task D9_MovingAPurchaseWithARefundLinkedToAnotherLine_IsRefusedAsSplittingIs_AndAllowedOnceUnlinked()
    {
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", 1000m, Sep1, AccountType.Current);
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 300m };
        var clothes = new BudgetItem { Name = "Clothes", PlannedAmount = 100m, DisplayOrder = 1 };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries, clothes } },
            },
        });
        db.SaveChanges();
        var purchase = LedgerFixtures.Expense(db, Owner, a.Id, 100m, Sep10, groceries.Id);
        var refund = LedgerFixtures.Income(db, Owner, a.Id, 20m, Sep12);
        await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(refund.Id, purchase.Id), Ct);
        db.ChangeTracker.Clear();
        var assign = new AssignTransactionCommandHandler(db, User);

        var move = () => assign.Handle(new AssignTransactionCommand(purchase.Id, clothes.Id), Ct);
        (await move.Should().ThrowAsync<ValidationException>()).Which.Errors["BudgetItemId"].Single()
            .Should().Be("This purchase has a refund linked to it. Unlink the refund before moving the purchase to another line.");
        var clear = () => assign.Handle(new AssignTransactionCommand(purchase.Id, null), Ct);
        await clear.Should().ThrowAsync<ValidationException>("taking it off every line orphans the refund the same way");
        db.ChangeTracker.Clear();
        (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == purchase.Id)).BudgetItemId.Should().Be(groceries.Id);

        // Re-saving the line it already has is not a move.
        (await assign.Handle(new AssignTransactionCommand(purchase.Id, groceries.Id), Ct)).BudgetItemId.Should().Be(groceries.Id);

        db.ChangeTracker.Clear();
        await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(refund.Id, null), Ct);
        db.ChangeTracker.Clear();
        (await assign.Handle(new AssignTransactionCommand(purchase.Id, clothes.Id), Ct)).BudgetItemId.Should().Be(clothes.Id);
    }

    // --- D1 on the pocket-money amount (P3-1) ---------------------------------------------------

    [Fact]
    public void D1_ThePocketMoneyAmount_IsWholeCents()
    {
        var validator = new UpsertAllocationProfileCommandValidator();
        UpsertAllocationProfileCommand Profile(decimal amount) => new(
            null, "Default", null, new[] { new AllocationRuleSpec(1, AllocationRuleType.FixedPerMember, SplitMethod.Equal, amount) });

        var refused = validator.Validate(Profile(10.005m));
        refused.IsValid.Should().BeFalse();
        refused.Errors.Should().ContainSingle(e => e.ErrorMessage == MoneyInput.TooPrecise);
        validator.Validate(Profile(10.05m)).IsValid.Should().BeTrue();
    }
}
