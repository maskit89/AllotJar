using FluentAssertions;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rule 14: a jar's "contributed this month" is what went into it, never netted against what
/// was spent from it (PR #286 review, P2-3: the figure was derived from two balances, so a bill
/// paid from the jar read as less contributed, and once the jar held less than it entered the
/// month with, nothing read as contributed at all). Money moved back out of the jar to
/// unallocated funds in the same month is a contribution undone, so it still nets
/// (<see cref="JarLedgerSource.ContributionsBetween"/>).
/// </summary>
public class JarContributionsRule14Tests
{
    private const string Owner = "user-1";
    private static readonly DateOnly Today = new(2026, 10, 10);
    private static readonly DateOnly October = new(2026, 10, 1);

    private static Jar SeedGoal(ApplicationDbContext db, Account account)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1500m, TargetDate = new DateOnly(2027, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static BudgetItem SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar, decimal planned)
    {
        var line = new BudgetItem { Name = jar.Name, PlannedAmount = planned, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    private static async Task<JarDto> ReadAsync(ApplicationDbContext db) =>
        (await new GetJarsQueryHandler(db, new CurrentUserStub(Owner)).Handle(new GetJarsQuery(AsOf: Today, Month: October), CancellationToken.None)).Single();

    /// <summary>Entered October with 100; 125 allocated in on the 5th (the whole plan); a line of 125.</summary>
    private static (Account Account, Jar Jar, BudgetItem Line) SeedOctober(ApplicationDbContext db)
    {
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var jar = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, new DateOnly(2026, 8, 20));
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 125m, new DateOnly(2026, 10, 5), JarAllocationKind.Reallocation);
        var line = SeedMonth(db, October, jar, 125m);
        return (account, jar, line);
    }

    [Fact]
    public async Task ABillPaidFromTheJar_DoesNotReduceWhatWasContributed()
    {
        await using var db = NewContext();
        var (account, _, line) = SeedOctober(db);
        LedgerFixtures.Expense(db, Owner, account.Id, 30m, new DateOnly(2026, 10, 8), line.Id);

        var october = await ReadAsync(db);

        october.CurrentBalance.Should().Be(195m);
        october.PlannedThisMonth.Should().Be(125m);
        october.ContributedThisMonth.Should().Be(125m, "rule 14: what went into the jar this month");
        october.RemainingThisMonth.Should().Be(0m);
    }

    [Fact]
    public async Task TheWholeContributionSpentInTheSameMonth_StillReadsAsContributed()
    {
        // The 225 bill the jar was saving for is paid from it in the month the plan was met.
        await using var db = NewContext();
        var (account, _, line) = SeedOctober(db);
        LedgerFixtures.Expense(db, Owner, account.Id, 225m, new DateOnly(2026, 10, 8), line.Id);

        var october = await ReadAsync(db);

        october.CurrentBalance.Should().Be(0m);
        october.ContributedThisMonth.Should().Be(125m);
        october.RemainingThisMonth.Should().Be(0m);
    }

    [Fact]
    public async Task MoneyMovedBackOutOfTheJar_IsAContributionUndone()
    {
        // 125 in on the 5th, 75 of it moved back to unallocated on the 7th: 50 contributed.
        await using var db = NewContext();
        var (account, jar, _) = SeedOctober(db);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, -75m, new DateOnly(2026, 10, 7), JarAllocationKind.Reallocation);

        var october = await ReadAsync(db);

        october.CurrentBalance.Should().Be(150m);
        october.ContributedThisMonth.Should().Be(50m);
        october.RemainingThisMonth.Should().Be(75m);
    }

    [Fact]
    public async Task ContributionsBetween_ReadsOnlyTheDatesAsked()
    {
        await using var db = NewContext();
        var (_, jar, _) = SeedOctober(db);
        var ledger = await JarLedgerReader.LoadAsync(db, Owner, CancellationToken.None);

        ledger.ContributionsBetween(October, Today).Should().Equal(new Dictionary<Guid, decimal> { [jar.Id] = 125m });
        // The 100 set aside when the jar was created is its opening balance, not a contribution (SC-P2-1).
        ledger.ContributionsBetween(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31)).Should().BeEmpty();
        ledger.SetAsideBetween(new DateOnly(2026, 8, 1), new DateOnly(2026, 8, 31)).Should().Equal(new Dictionary<Guid, decimal> { [jar.Id] = 100m });
        ledger.SetAsideBetween(October, Today).Should().BeEmpty();
        ledger.ContributionsBetween(new DateOnly(2026, 9, 1), new DateOnly(2026, 9, 30)).Should().BeEmpty();
    }
}
