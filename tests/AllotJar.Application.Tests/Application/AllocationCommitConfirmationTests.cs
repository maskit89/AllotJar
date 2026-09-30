using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rules 7/29/71 on the allocation commit: suggested surpluses stay a plan until the user
/// confirms "I've completed these transfers" with the departure date; the commit then records
/// departures (receipt unknown), and re-running never rewrites a transfer whose receipt the bank
/// has already confirmed. Solo member: June's budgeted income 3,000 (rule 28) − envelopes 1,000 −
/// jars 500 − pocket 250 = 1,250.
/// </summary>
public class AllocationCommitConfirmationTests
{
    private static readonly CurrentUserStub User = new("user-1");
    private static readonly DateOnly Departure = new(2026, 6, 3);

    private static Account SeedAccount(ApplicationDbContext db, string name, decimal opening = 0m)
    {
        var a = new Account
        {
            OwnerId = "user-1", Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(a);
        db.SaveChanges();
        return a;
    }

    private static HouseholdMember SeedMember(ApplicationDbContext db, string name, decimal net, int order, Guid? savings)
    {
        var member = new HouseholdMember
        {
            OwnerId = "user-1", Name = name, NetMonthlyIncome = net, DisplayOrder = order, PersonalSavingsAccountId = savings,
        };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member;
    }

    private static void SeedBudget(ApplicationDbContext db, decimal envelopes = 1000m, decimal funds = 500m)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = envelopes } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = funds } } },
            },
        });
        db.SaveChanges();
    }

    /// <summary>The month's income line attributed to <paramref name="member"/> — the only income the engine reads (rule 28).</summary>
    private static void SeedIncomeLine(ApplicationDbContext db, HouseholdMember member, decimal amount)
    {
        var bm = db.BudgetMonths.Single(b => b.OwnerId == "user-1" && b.Year == 2026 && b.Month == 6);
        db.BudgetCategories.Add(new BudgetCategory
        {
            BudgetMonthId = bm.Id, Name = "Income", Kind = CategoryKind.Income,
            Items = new List<BudgetItem> { new() { Name = member.Name, PlannedAmount = amount, MemberId = member.Id } },
        });
        db.SaveChanges();
    }

    /// <summary>Corrects the member's June income line — the way a household changes its income.</summary>
    private static async Task SetIncomeLineAsync(ApplicationDbContext db, HouseholdMember member, decimal amount)
    {
        var line = await db.BudgetItems.SingleAsync(i => i.MemberId == member.Id);
        line.PlannedAmount = amount;
        await db.SaveChangesAsync();
    }

    private static Task SeedProfile(ApplicationDbContext db, Guid source) =>
        new UpsertAllocationProfileCommandHandler(db, User).Handle(
            new UpsertAllocationProfileCommand(null, "P", source, new List<AllocationRuleSpec>
            {
                new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
                new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m),
                new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, 250m),
                new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
            }), CancellationToken.None);

    private static AllocateIncomeCommand Confirmed(DateOnly? receivedOn = null) =>
        new(2026, 6, DepartedOn: Departure, ReceivedOn: receivedOn, ConfirmedCompleted: true);

    private static async Task<(Account Source, Account Savings, HouseholdMember Member)> SoloHouseholdAsync(ApplicationDbContext db)
    {
        var source = SeedAccount(db, "Joint", 5000m);
        var savings = SeedAccount(db, "Alex savings", 100m);
        var member = SeedMember(db, "Alex", 3000m, 0, savings.Id);
        SeedBudget(db);
        SeedIncomeLine(db, member, 3000m);
        await SeedProfile(db, source.Id);
        return (source, savings, member);
    }

    [Fact]
    public async Task Commit_RequiresTheCompletedConfirmation_AndTheDepartureDate()
    {
        var validation = new AllocateIncomeCommandValidator().Validate(new AllocateIncomeCommand(2026, 6));
        validation.IsValid.Should().BeFalse();
        validation.Errors.Select(e => e.PropertyName).Should().Contain(new[] { "ConfirmedCompleted", "DepartedOn" });

        await using var db = NewContext();
        await SoloHouseholdAsync(db);
        await Assert.ThrowsAsync<ValidationException>(() =>
            new AllocateIncomeCommandHandler(db, User)
                .Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: Departure, ConfirmedCompleted: false), CancellationToken.None));
        (await db.Transactions.CountAsync()).Should().Be(0, "an unconfirmed plan records no money");
    }

    [Fact]
    public async Task Commit_RecordsAConfirmedDeparture_WithReceiptUnknownUnlessSupplied()
    {
        await using var db = NewContext();
        var (source, savings, _) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);

        var result = await handler.Handle(Confirmed(), CancellationToken.None);

        result.TransfersCreated.Should().Be(1);
        var transfer = await db.Transactions.SingleAsync();
        transfer.Amount.Should().Be(1250m);
        transfer.AccountId.Should().Be(source.Id);
        transfer.TransferAccountId.Should().Be(savings.Id);
        transfer.DepartedOn.Should().Be(Departure);
        transfer.Date.Should().Be(Departure);
        transfer.ReceivedOn.Should().BeNull();
        transfer.TransferStatus.Should().Be(TransferStatus.InTransit);

        // A user who knows the money arrived the same day may say so up front.
        await using var db2 = NewContext();
        await SoloHouseholdAsync(db2);
        await new AllocateIncomeCommandHandler(db2, User).Handle(Confirmed(receivedOn: Departure), CancellationToken.None);
        (await db2.Transactions.SingleAsync()).TransferStatus.Should().Be(TransferStatus.Completed);
    }

    [Fact]
    public async Task ReRun_AfterTheSurplusChanges_ReplacesTheInTransitTransfer_WithTheNewDeparture()
    {
        await using var db = NewContext();
        var (_, savings, alex) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);
        var before = await db.Transactions.SingleAsync();

        // The month's income is corrected upwards, so the surplus the user moved is different.
        await SetIncomeLineAsync(db, alex, 3500m);
        var rerun = await handler.Handle(
            new AllocateIncomeCommand(2026, 6, DepartedOn: new DateOnly(2026, 6, 4), ConfirmedCompleted: true), CancellationToken.None);

        rerun.TransfersCreated.Should().Be(1);
        var after = await db.Transactions.SingleAsync();
        after.Id.Should().NotBe(before.Id, "the superseded in-transit row is withdrawn, not edited");
        after.Amount.Should().Be(1750m); // 3,500 − 1,000 − 500 − 250
        after.DepartedOn.Should().Be(new DateOnly(2026, 6, 4));
        after.ReceivedOn.Should().BeNull();
        after.TransferAccountId.Should().Be(savings.Id);
    }

    [Fact]
    public async Task ReRun_RefusesToDiscardATransferWhoseReceiptIsConfirmed()
    {
        await using var db = NewContext();
        var (_, savings, alex) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);
        var recorded = await db.Transactions.SingleAsync();
        await new ConfirmTransferLegsCommandHandler(db, User)
            .Handle(new ConfirmTransferLegsCommand(recorded.Id, ReceivedOn: Departure.AddDays(1)), CancellationToken.None);

        await SetIncomeLineAsync(db, alex, 3500m);
        var ex = await Assert.ThrowsAsync<ValidationException>(() => handler.Handle(Confirmed(), CancellationToken.None));

        ex.Errors["Allocation"].Single().Should().Contain("confirmed as received");
        var untouched = await db.Transactions.SingleAsync();
        untouched.Id.Should().Be(recorded.Id);
        untouched.Amount.Should().Be(1250m);
        untouched.ReceivedOn.Should().Be(Departure.AddDays(1));
        untouched.TransferAccountId.Should().Be(savings.Id);
    }

    [Fact]
    public async Task ReRun_DropsAnInTransitTransfer_WhenTheMemberNoLongerReceivesOne()
    {
        await using var db = NewContext();
        var (_, _, alex) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);

        alex.PersonalSavingsAccountId = null; // no destination this time
        await db.SaveChangesAsync();
        var rerun = await handler.Handle(Confirmed(), CancellationToken.None);

        rerun.TransfersCreated.Should().Be(0);
        (await db.Transactions.CountAsync()).Should().Be(0, "an in-transit suggestion that no longer applies is withdrawn");
    }

    // #279 P3-4: a transfer that came back (rule 90) funded nothing, so a re-run records the
    // member's movement again beside it; the returned one stays as bank history.
    [Fact]
    public async Task ReRun_KeepsAReturnedTransfer_AndRecordsTheMembersMovementAgainBesideIt()
    {
        await using var db = NewContext();
        var (source, savings, _) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);
        var first = await db.Transactions.SingleAsync();
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(first.Id, source.Id, savings.Id, 1250m, Departure, null, ReturnedOn: Departure.AddDays(2)), CancellationToken.None);

        var rerun = await handler.Handle(
            new AllocateIncomeCommand(2026, 6, DepartedOn: Departure.AddDays(3), ConfirmedCompleted: true), CancellationToken.None);

        rerun.TransfersCreated.Should().Be(1);
        rerun.TransfersRetained.Should().Be(0);
        var rows = await db.Transactions.OrderBy(t => t.DepartedOn).ToListAsync();
        rows.Should().HaveCount(2);
        rows[0].Id.Should().Be(first.Id);
        rows[0].ReturnedOn.Should().Be(Departure.AddDays(2), "the returned transfer is history, left as it was");
        rows[1].Amount.Should().Be(1250m);
        rows[1].DepartedOn.Should().Be(Departure.AddDays(3));
        rows[1].ReturnedOn.Should().BeNull();
        rows[1].TransferAccountId.Should().Be(savings.Id);
        AllocateIncomeCommandHandler.MemberKeyOf(rows[1].AllocationKey!).Should().Be(rows[0].AllocationKey);
        rows[1].AllocationKey.Should().NotBe(rows[0].AllocationKey);

        // Running it once more finds the live transfer unchanged and leaves both alone.
        var again = await handler.Handle(
            new AllocateIncomeCommand(2026, 6, DepartedOn: Departure.AddDays(3), ConfirmedCompleted: true), CancellationToken.None);
        again.TransfersCreated.Should().Be(0);
        again.TransfersRetained.Should().Be(1);
        (await db.Transactions.CountAsync()).Should().Be(2);
    }

    // #287 review P2-3: the user un-marks the return after a re-run recorded the next transfer,
    // so two live transfers fund one member; the next run withdraws the later in-transit one.
    [Fact]
    public async Task ReRun_WithTwoLiveTransfersForOneMember_WithdrawsTheLaterInTransitOne()
    {
        await using var db = NewContext();
        var (source, savings, _) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);
        var first = await db.Transactions.SingleAsync();
        var edit = new UpdateTransferCommandHandler(db, User);
        await edit.Handle(new UpdateTransferCommand(first.Id, source.Id, savings.Id, 1250m, Departure, null, ReturnedOn: Departure.AddDays(2)), CancellationToken.None);
        await handler.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: Departure.AddDays(3), ConfirmedCompleted: true), CancellationToken.None);
        (await db.Transactions.CountAsync()).Should().Be(2);
        await edit.Handle(new UpdateTransferCommand(first.Id, source.Id, savings.Id, 1250m, Departure, null, ReturnedOn: null), CancellationToken.None);

        var third = await handler.Handle(new AllocateIncomeCommand(2026, 6, DepartedOn: Departure.AddDays(3), ConfirmedCompleted: true), CancellationToken.None);

        third.TransfersCreated.Should().Be(0);
        third.TransfersRetained.Should().Be(1);
        var live = await db.Transactions.Where(t => t.ReturnedOn == null).ToListAsync();
        live.Should().ContainSingle().Which.Id.Should().Be(first.Id, "the first transfer is the member's; the later one was still in transit and goes");
    }

    [Fact]
    public async Task ReRun_WhenTheMemberNoLongerReceivesOne_LeavesTheReturnedTransferAlone()
    {
        await using var db = NewContext();
        var (source, savings, alex) = await SoloHouseholdAsync(db);
        var handler = new AllocateIncomeCommandHandler(db, User);
        await handler.Handle(Confirmed(), CancellationToken.None);
        var first = await db.Transactions.SingleAsync();
        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(first.Id, source.Id, savings.Id, 1250m, Departure, null, ReturnedOn: Departure.AddDays(2)), CancellationToken.None);

        alex.PersonalSavingsAccountId = null;
        await db.SaveChangesAsync();
        var rerun = await handler.Handle(Confirmed(), CancellationToken.None);

        rerun.TransfersCreated.Should().Be(0);
        (await db.Transactions.SingleAsync()).Id.Should().Be(first.Id, "a transfer that left and came back is bank history");
    }
}
