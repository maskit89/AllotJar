using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Sinking-fund management: definitions (target/date/accrual), the read-time-derived
/// balance/required/status from the actual-money ledger (rule 1: planned contributions
/// never count), and seeding a new month's contribution from the accrual calculator.
/// </summary>
public class JarsTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    /// <summary>A jar in <paramref name="account"/>; <paramref name="allocated"/> is an initial allocation from the account's money (rule 77).</summary>
    private static Jar SeedFund(
        ApplicationDbContext db, string ownerId, Guid id, decimal target, Account account,
        AccrualMethod accrual = AccrualMethod.TargetByDate, DateOnly? targetDate = null,
        decimal allocated = 0m, DateOnly? allocatedOn = null, bool archived = false)
    {
        var fund = new Jar
        {
            Id = id,
            OwnerId = ownerId,
            Name = "Holiday",
            Kind = JarKind.Recurring,
            TargetAmount = target,
            Accrual = accrual,
            TargetDate = targetDate,
            FundingAccountId = account.Id,
            IsArchived = archived,
        };
        db.Jars.Add(fund);
        db.SaveChanges();
        if (allocated != 0m)
        {
            LedgerFixtures.Allocate(db, ownerId, account.Id, id, allocated, allocatedOn);
        }
        return fund;
    }

    // Seeds a Fund-group budget line for a fund, optionally with a tracked spend from the jar's account (rule 79).
    private static BudgetItem SeedFundLine(
        ApplicationDbContext db, string ownerId, Guid fundId, int year, int month,
        decimal planned, decimal spent = 0m, Guid? spentFrom = null)
    {
        var line = new BudgetItem
        {
            Name = "Holiday",
            SavingsId = fundId,
            PlannedAmount = planned,
        };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();

        if (spent > 0m)
        {
            LedgerFixtures.Expense(db, ownerId, spentFrom!.Value, spent, new DateOnly(year, month, 15), line.Id);
        }

        return line;
    }

    [Fact]
    public async Task Create_PersistsOwnerAndFields()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        // Due on the 1st three months out: this month and the next two plan 100 each (rule 12).
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var due = new DateOnly(today.Year, today.Month, 1).AddMonths(3);
        var dto = await handler.Handle(new CreateJarCommand(
            "Home Insurance", JarKind.Recurring, 300m, due,
            AccrualMethod.TargetByDate, FundingAccountId: account.Id), CancellationToken.None);

        dto.Name.Should().Be("Home Insurance");
        dto.FundingAccountId.Should().Be(account.Id);
        dto.PlannedThisMonth.Should().Be(100.00m);
        dto.FundingCompletesOn.Should().Be(due.AddDays(-1));
        dto.Deadline.Should().Be(due);
        dto.CurrentBalance.Should().Be(0m);

        var stored = await db.Jars.SingleAsync();
        stored.OwnerId.Should().Be("user-1");
        stored.FundingAccountId.Should().Be(account.Id);
        stored.RecurMonths.Should().Be(12); // Recurring defaults to a yearly cycle
    }

    [Fact]
    public async Task Get_IsOwnerScoped_AndExcludesArchivedByDefault()
    {
        await using var db = NewContext();
        var mine = LedgerFixtures.SeedAccount(db, "user-1");
        var theirs = LedgerFixtures.SeedAccount(db, "user-2");
        SeedFund(db, "user-1", Guid.NewGuid(), 300m, mine);
        SeedFund(db, "user-1", Guid.NewGuid(), 300m, mine, archived: true);
        SeedFund(db, "user-2", Guid.NewGuid(), 300m, theirs);

        var handler = new GetJarsQueryHandler(db, new CurrentUserStub("user-1"));

        var active = await handler.Handle(new GetJarsQuery(), CancellationToken.None);
        active.Should().ContainSingle().Which.IsArchived.Should().BeFalse();

        var all = await handler.Handle(new GetJarsQuery(IncludeArchived: true), CancellationToken.None);
        all.Should().HaveCount(2);
    }

    [Fact]
    public async Task JarRead_IgnoresPlannedContributions_CountsAllocationsAndJarLineExpenses()
    {
        // Rule 1: a planned contribution is not money. Only the initial allocation and the
        // expense recorded on the jar's line from its account (rule 79) move the balance.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 1000m, account, allocated: 50m);
        SeedFundLine(db, "user-1", fundId, 2026, 6, planned: 100m, spent: 30m, spentFrom: account.Id);

        var handler = new GetJarsQueryHandler(db, new CurrentUserStub("user-1"));
        var funds = await handler.Handle(new GetJarsQuery(), CancellationToken.None);

        funds.Single().CurrentBalance.Should().Be(20m); // 50 allocated − 30 spent; the planned 100 never counts
    }

    [Fact]
    public async Task Get_PlansThisMonthFromTheMonthStartBalance_AndShowsContributedAndRemaining()
    {
        // Rule 14: 1,200 due 1 November, planned from the balance entering the month; 200 lands on
        // 5 January. January's plan stays 1,200 ÷ 10 months = 120 — it is not reduced by the 200 —
        // while "contributed this month" reads 200 and "still to contribute" 0.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 1200m, account,
            accrual: AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 11, 1),
            allocated: 200m, allocatedOn: new DateOnly(2026, 1, 5));
        var handler = new GetJarsQueryHandler(db, new CurrentUserStub("user-1"));

        var january = (await handler.Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 1, 15)), CancellationToken.None)).Single();
        january.PlannedThisMonth.Should().Be(120.00m);
        january.ContributedThisMonth.Should().Be(200m);
        january.RemainingThisMonth.Should().Be(0m);
        january.Deadline.Should().Be(new DateOnly(2026, 11, 1));
        january.FundingCompletesOn.Should().Be(new DateOnly(2026, 10, 31));

        // Rule 13: February recalculates from what was actually saved by the end of January:
        // (1,200 − 200) ÷ 9 months = 111.11, with the remainder due in the final month (rule 35).
        var february = (await handler.Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 2, 1)), CancellationToken.None)).Single();
        february.PlannedThisMonth.Should().Be(111.11m);
        february.ContributedThisMonth.Should().Be(0m);
        february.RemainingThisMonth.Should().Be(111.11m);
    }

    [Fact]
    public async Task Get_Status_IsFullyFunded_WhenBalanceMeetsTarget()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        SeedFund(db, "user-1", Guid.NewGuid(), target: 100m, account, allocated: 100m);

        var funds = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);

        funds.Single().Status.Should().Be("FullyFunded");
    }

    [Fact]
    public async Task Get_Status_IsOverspent_WhenBalanceGoesNegative()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 100m, account);
        // Rule 5: a payment may take a jar negative; the plan (10) never covers it.
        SeedFundLine(db, "user-1", fundId, 2026, 6, planned: 10m, spent: 50m, spentFrom: account.Id); // 0 − 50 = −50

        var funds = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);

        funds.Single().Status.Should().Be("Overspent");
        funds.Single().CurrentBalance.Should().Be(-50m);
    }

    [Fact]
    public async Task Get_Status_IsUnavailable_WhenTheAccountHasNoBalanceYet()
    {
        // Rule 67: before the account's opening date there is no balance to show — never zero.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", openingDate: new DateOnly(2026, 6, 1));
        SeedFund(db, "user-1", Guid.NewGuid(), target: 100m, account);

        var funds = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 5, 31)), CancellationToken.None);

        funds.Single().CurrentBalance.Should().BeNull();
        funds.Single().Status.Should().Be("Unavailable");
    }

    [Fact]
    public async Task Update_EditsFields()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 300m, account);

        var dto = await new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateJarCommand(
                fundId, "Renamed", JarKind.Goal, 500m, null,
                AccrualMethod.FixedMonthly, account.Id, MonthlyContribution: 50m), CancellationToken.None);

        dto.Name.Should().Be("Renamed");
        dto.TargetAmount.Should().Be(500m);
        dto.Accrual.Should().Be(AccrualMethod.FixedMonthly);
        dto.MonthlyContribution.Should().Be(50m);
        dto.PlannedThisMonth.Should().Be(50m);
        dto.EstimatedMonthsToTarget.Should().Be(10); // rule 58: 500 at 50 a month
        dto.Deadline.Should().BeNull();
    }

    [Fact]
    public async Task Update_Throws_WhenMissing()
    {
        await using var db = NewContext();
        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() => handler.Handle(
            new UpdateJarCommand(Guid.NewGuid(), "X", JarKind.Recurring, 1m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid()), CancellationToken.None));
    }

    [Fact]
    public async Task Update_Throws_WhenOwnedByAnotherUser()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 300m, account);

        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-2"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() => handler.Handle(
            new UpdateJarCommand(fundId, "X", JarKind.Recurring, 1m, null,
                AccrualMethod.TargetByDate, account.Id), CancellationToken.None));
    }

    [Fact]
    public async Task Archive_HidesFromDefaultList()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 300m, account); // zero balance: archivable (rule 26)

        await new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveJarCommand(fundId), CancellationToken.None);

        var active = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);
        active.Should().BeEmpty();
    }

    [Fact]
    public async Task CreateBudgetMonth_SeedsFundContribution_FromTheLedgerBalance_NotThePlannedLine()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        // Target 1200 by 1 Dec. May planned 200 but only 200 actually allocated in May counts.
        SeedFund(db, "user-1", fundId, target: 1200m, account,
            accrual: AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 12, 1),
            allocated: 200m, allocatedOn: new DateOnly(2026, 5, 15));
        SeedFundLine(db, "user-1", fundId, 2026, 5, planned: 200m); // May contribution (a plan)

        await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneLine = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.SavingsId == fundId && i.BudgetCategory.BudgetMonth.Month == 6);

        // Balance entering June (as of 31 May) = 200 allocated; remaining 1000 over the six
        // contribution months Jun→Nov (the deadline day itself is not a contribution day, rule 12)
        // = 166.666…, floored to the cent with the remainder in the final month (rule 35).
        juneLine.PlannedAmount.Should().Be(166.66m);
    }

    [Fact]
    public async Task CreateBudgetMonth_SeedsFromNothingSaved_WhenOnlyAPlanExists()
    {
        // Rule 1: a planned May line with no money behind it leaves the jar empty, so June is
        // seeded from the full remaining target — the plan is never folded in as savings.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 1200m, account,
            accrual: AccrualMethod.TargetByDate, targetDate: new DateOnly(2026, 12, 1));
        SeedFundLine(db, "user-1", fundId, 2026, 5, planned: 200m);

        await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneLine = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.SavingsId == fundId && i.BudgetCategory.BudgetMonth.Month == 6);

        juneLine.PlannedAmount.Should().Be(200m); // 1200 / 6 months (Jun→Dec)
    }

    [Fact]
    public async Task CreateBudgetMonth_KeepsCopiedAmount_WhenFundHasNoTarget()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var fundId = Guid.NewGuid();
        SeedFund(db, "user-1", fundId, target: 0m, account); // unconfigured target → not seeded
        SeedFundLine(db, "user-1", fundId, 2026, 5, planned: 200m);

        await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneLine = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.SavingsId == fundId && i.BudgetCategory.BudgetMonth.Month == 6);

        juneLine.PlannedAmount.Should().Be(200m); // copied, not recomputed
    }

    [Fact]
    public void Validator_RejectsEmptyName_NegativeTarget_MissingAccount_AndAJarWithNoPlan()
    {
        var validator = new CreateJarCommandValidator();
        var account = Guid.NewGuid();
        var due = new DateOnly(2026, 12, 1);

        validator.Validate(new CreateJarCommand(
            "", JarKind.Recurring, 100m, due,
            AccrualMethod.TargetByDate, account)).Errors
            .Should().ContainSingle(e => e.ErrorMessage == "A jar needs a name.");

        validator.Validate(new CreateJarCommand(
            "X", JarKind.Recurring, -1m, due,
            AccrualMethod.TargetByDate, account)).IsValid.Should().BeFalse();

        // Rule 73: no jar without its account.
        validator.Validate(new CreateJarCommand(
            "X", JarKind.Recurring, 100m, due,
            AccrualMethod.TargetByDate, Guid.Empty)).Errors
            .Should().ContainSingle(e => e.ErrorMessage == "Choose the account this jar's money is held in.");

        // Rule 17: a target is saved by a deadline or at a fixed monthly amount — never neither.
        validator.Validate(new CreateJarCommand(
            "X", JarKind.Goal, 100m, null,
            AccrualMethod.TargetByDate, account)).Errors
            .Should().Contain(e => e.ErrorMessage == "Give the jar a deadline, or save a fixed amount each month instead.");
        validator.Validate(new CreateJarCommand(
            "X", JarKind.Goal, 100m, null,
            AccrualMethod.FixedMonthly, account)).Errors
            .Should().Contain(e => e.ErrorMessage == "Enter the amount to set aside each month.");
        // A recurring jar saves toward its due date (a fixed monthly plan has no deadline to roll).
        validator.Validate(new CreateJarCommand(
            "X", JarKind.Recurring, 100m, null,
            AccrualMethod.FixedMonthly, account, MonthlyContribution: 10m)).Errors
            .Should().Contain(e => e.ErrorMessage == "A recurring jar saves toward its next due date.");
        // Rule 16: an ongoing jar — a fixed monthly amount and no target — is a valid plan.
        validator.Validate(new CreateJarCommand(
            "Rainy day", JarKind.Goal, 0m, null,
            AccrualMethod.FixedMonthly, account, MonthlyContribution: 50m)).IsValid.Should().BeTrue();
    }
}
