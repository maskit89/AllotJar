using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation.Commands.AllocateIncome;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The allocation commit's money rules: its transfers must leave the source account at or above
/// zero (rule 74, key "Allocation"), and each member's receipt may be divided among the jars of
/// their savings account (rule 78), applying once the receipt is posted. Solo member: June's budgeted
/// income 3,000 (rule 28) − envelopes 1,000 − jars 500 − pocket 250 = 1,250 transferred from Joint to
/// Alex's savings.
/// </summary>
public class AllocationJarPromptTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly DateOnly Departure = new(2026, 6, 3);
    private static readonly DateOnly Receipt = new(2026, 6, 4);
    private static readonly DateOnly AsOf = new(2026, 6, 30);

    private static HouseholdMember SeedMember(ApplicationDbContext db, string name, decimal net, Guid savings)
    {
        var member = new HouseholdMember { OwnerId = Owner, Name = name, NetMonthlyIncome = net, DisplayOrder = 0, PersonalSavingsAccountId = savings };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member;
    }

    private static Jar SeedJar(ApplicationDbContext db, Account account, string name)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 5000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>June's budget, with the member's 3,000 as an attributed income line (rule 28).</summary>
    private static void SeedBudget(ApplicationDbContext db, HouseholdMember member)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { new() { Name = member.Name, PlannedAmount = 3000m, MemberId = member.Id } } },
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = 1000m } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = 500m } } },
            },
        });
        db.SaveChanges();
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

    private sealed record Household(Account Source, Account Savings, HouseholdMember Alex, Jar Holiday);

    /// <summary>Joint (source) and Alex's savings of 100 backing an empty Holiday jar; Alex's June income line is 3,000.</summary>
    private static async Task<Household> SeedHouseholdAsync(ApplicationDbContext db, decimal sourceOpening = 5000m)
    {
        var source = LedgerFixtures.SeedAccount(db, Owner, "Joint", opening: sourceOpening, type: AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Alex savings", opening: 100m, order: 1);
        var holiday = SeedJar(db, savings, "Holiday");
        var alex = SeedMember(db, "Alex", 3000m, savings.Id);
        SeedBudget(db, alex);
        await SeedProfile(db, source.Id);
        return new Household(source, savings, alex, holiday);
    }

    private static AllocateIncomeCommand Commit(DateOnly? receivedOn = null, IReadOnlyList<AllocateIncomeJarAllocation>? jarAllocations = null) =>
        new(2026, 6, DepartedOn: Departure, ReceivedOn: receivedOn, ConfirmedCompleted: true, JarAllocations: jarAllocations);

    private static Task<JarLedgerSnapshot> ReadAsync(ApplicationDbContext db) =>
        JarLedgerReader.ReadAsync(db, Owner, AsOf, CancellationToken.None);

    // ---- Rule 74 --------------------------------------------------------------------------------

    [Fact]
    public async Task Commit_WhoseTransfersExceedTheSourceAccountsMoney_IsRefused()
    {
        await using var db = NewContext();
        await SeedHouseholdAsync(db, sourceOpening: 1000m); // 1,250 leaves on 3 June → −250

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            new AllocateIncomeCommandHandler(db, User).Handle(Commit(), CancellationToken.None));

        ex.Errors.Should().ContainKey("Allocation").WhoseValue.Single()
            .Should().Contain("Joint would be -250.00").And.Contain("2026-06-03");
        (await db.Transactions.CountAsync()).Should().Be(0, "no transfer is recorded when the source cannot cover it");

        // With exactly enough money the same commit goes through.
        await using var db2 = NewContext();
        var h = await SeedHouseholdAsync(db2, sourceOpening: 1250m);
        var result = await new AllocateIncomeCommandHandler(db2, User).Handle(Commit(), CancellationToken.None);
        result.TransfersCreated.Should().Be(1);
        (await db2.Transactions.SingleAsync()).Amount.Should().Be(1250m);
    }

    // ---- Rule 78 --------------------------------------------------------------------------------

    [Fact]
    public async Task Commit_WithJarAllocationsAndReceivedOn_CreditsTheMembersSavingsJar()
    {
        await using var db = NewContext();
        var h = await SeedHouseholdAsync(db);

        var result = await new AllocateIncomeCommandHandler(db, User).Handle(
            Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(h.Alex.Id, h.Holiday.Id, 1000m) }),
            CancellationToken.None);

        result.TransfersCreated.Should().Be(1);
        var transfer = await db.Transactions.AsNoTracking().SingleAsync();
        transfer.TransferAccountId.Should().Be(h.Savings.Id);
        transfer.ReceivedOn.Should().Be(Receipt);

        var snapshot = await ReadAsync(db);
        snapshot.BalanceOf(h.Holiday.Id).Should().Be(1000m);
        snapshot.Accounts[h.Savings.Id].Unallocated.Should().Be(350m, "100 already there plus the 250 not put in a jar");
        snapshot.Accounts[h.Savings.Id].AccountBalance.Should().Be(1350m);
        snapshot.Accounts[h.Savings.Id].UnreconciledAllocations.Should().Be(0);

        var stored = await db.JarAllocations.AsNoTracking().Include(a => a.Postings)
            .SingleAsync(a => a.TransactionId == transfer.Id);
        stored.AccountId.Should().Be(h.Savings.Id);
        stored.Kind.Should().Be(JarAllocationKind.Movement);
        stored.Date.Should().Be(Receipt);
        stored.Postings.Single(p => p.JarId == h.Holiday.Id).Amount.Should().Be(1000m);
        stored.Postings.Single(p => p.JarId == null).Amount.Should().Be(250m);
    }

    [Fact]
    public async Task Commit_WithJarAllocations_ButReceiptUnknown_AppliesTheAnswerOnceTheReceiptIsConfirmed()
    {
        await using var db = NewContext();
        var h = await SeedHouseholdAsync(db);

        await new AllocateIncomeCommandHandler(db, User).Handle(
            Commit(jarAllocations: new[] { new AllocateIncomeJarAllocation(h.Alex.Id, h.Holiday.Id, 1000m) }), CancellationToken.None);

        var inTransit = await ReadAsync(db);
        inTransit.BalanceOf(h.Holiday.Id).Should().Be(0m, "money in transit is in no jar");
        inTransit.Accounts[h.Savings.Id].AccountBalance.Should().Be(100m);

        var transfer = await db.Transactions.AsNoTracking().SingleAsync();
        await new ConfirmTransferLegsCommandHandler(db, User).Handle(
            new ConfirmTransferLegsCommand(transfer.Id, ReceivedOn: Receipt), CancellationToken.None);

        var received = await ReadAsync(db);
        received.BalanceOf(h.Holiday.Id).Should().Be(1000m);
        received.Accounts[h.Savings.Id].Unallocated.Should().Be(350m);
        received.Accounts[h.Savings.Id].AccountBalance.Should().Be(1350m);
    }

    [Fact]
    public async Task Commit_WithJarAllocations_ForAnUnknownMember_IsRefused_AndNothingIsRecorded()
    {
        await using var db = NewContext();
        var h = await SeedHouseholdAsync(db);

        var ex = await Assert.ThrowsAsync<ValidationException>(() => new AllocateIncomeCommandHandler(db, User).Handle(
            Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(Guid.NewGuid(), h.Holiday.Id, 100m) }),
            CancellationToken.None));

        ex.Errors.Should().ContainKey("JarAllocations").WhoseValue.Single().Should().Contain("no allocation transfer");
        (await db.Transactions.CountAsync()).Should().Be(0);
        (await db.JarAllocations.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Commit_WithJarAllocations_ExceedingTheMembersTransfer_IsRefused()
    {
        await using var db = NewContext();
        var h = await SeedHouseholdAsync(db);

        var ex = await Assert.ThrowsAsync<ValidationException>(() => new AllocateIncomeCommandHandler(db, User).Handle(
            Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(h.Alex.Id, h.Holiday.Id, 1300m) }),
            CancellationToken.None));

        ex.Errors["JarAllocations"].Single().Should().Contain("1300").And.Contain("1250");
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public void Validator_RejectsAJarAllocation_MissingItsMemberOrJar()
    {
        var validator = new AllocateIncomeCommandValidator();

        var missingMember = validator.Validate(Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(Guid.Empty, Guid.NewGuid(), 10m) }));
        missingMember.IsValid.Should().BeFalse();
        missingMember.Errors.Should().Contain(e => e.PropertyName == "JarAllocations");

        var negative = validator.Validate(Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(Guid.NewGuid(), Guid.NewGuid(), -1m) }));
        negative.IsValid.Should().BeFalse();

        validator.Validate(Commit(receivedOn: Receipt, jarAllocations: new[] { new AllocateIncomeJarAllocation(Guid.NewGuid(), Guid.NewGuid(), 10m) }))
            .IsValid.Should().BeTrue();
    }
}
