using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Month-boundary behaviour with the clock pinned (holistic review M9), so it is tested on the
/// days it can go wrong rather than on whatever today is: the last day of a month and the 1st
/// after it, across a year end, a common February and a leap February. Each handler here takes
/// a <see cref="TimeProvider"/>; the real clock is never read.
/// </summary>
public class MonthEndClockTests
{
    private const string Owner = "user-1";

    /// <summary>Each month's last day: the 1st after it is the day after.</summary>
    public static TheoryData<string> LastDays() => new()
    {
        "2026-12-31", // year end
        "2027-01-31",
        "2027-02-28", // common February
        "2028-02-29", // leap February
        "2027-04-30", // a 30-day month
    };

    private static Jar SeedBill(ApplicationDbContext db, Account account, DateOnly due, bool monthOnly = false, decimal target = 600m)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = target, TargetDate = due,
            CycleDeadline = due, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12, FundingAccountId = account.Id,
            MonthOnly = monthOnly,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static async Task<JarDto> ReadOnAsync(ApplicationDbContext db, DateOnly today) =>
        (await new GetJarsQueryHandler(db, new CurrentUserStub(Owner), new FixedClock(today))
            .Handle(new GetJarsQuery(), CancellationToken.None)).Single();

    // ---- Rules 82 and 92: Behind turns into Deadline missed on the right day ------------------

    [Theory]
    [MemberData(nameof(LastDays))]
    public async Task ABillDueOnThe1st_StillShort_IsNotMissedOnTheLastDay_AndMissedOnThe1st(string last)
    {
        var lastDay = DateOnly.Parse(last);
        var first = lastDay.AddDays(1);
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedBill(db, account, due: first);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, lastDay.AddDays(-40));

        var before = await ReadOnAsync(db, lastDay);
        // A full date: no warning beforehand (that is the month-only rule 92), missed on the day itself.
        before.Status.Should().Be("OnTrack", $"{lastDay} is the day before the deadline");
        (await db.JarCycles.CountAsync()).Should().Be(0);

        var on = await ReadOnAsync(db, first);
        on.Status.Should().Be("DeadlineMissed", $"{first} is the deadline itself");
        on.Shortfall.Should().Be(150m);
        on.Deadline.Should().Be(first);
    }

    [Theory]
    [MemberData(nameof(LastDays))]
    public async Task ABillDueInAMonth_StillShort_IsBehindToItsLastDay_AndMissedFromTheNext1st(string last)
    {
        // The bill's month is the one that ends on lastDay; month-only, so it is stored as that month's 1st.
        var lastDay = DateOnly.Parse(last);
        var due = new DateOnly(lastDay.Year, lastDay.Month, 1);
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedBill(db, account, due, monthOnly: true);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 450m, due.AddDays(-40));

        (await ReadOnAsync(db, due)).Status.Should().Be("Behind", "the month has begun");
        (await ReadOnAsync(db, lastDay)).Status.Should().Be("Behind", $"{lastDay} is still within the month");
        (await db.JarCycles.CountAsync()).Should().Be(0, "nothing settles while the month runs");

        var after = await ReadOnAsync(db, lastDay.AddDays(1));
        after.Status.Should().Be("DeadlineMissed", "the month is over");
        after.Shortfall.Should().Be(150m);
    }

    // ---- New-month creation on the last day and on the 1st (rule 21 inside month creation) ----

    [Theory]
    [MemberData(nameof(LastDays))]
    public async Task CreatingTheNextMonth_RollsAFundedCycle_OnlyOnceItsDeadlineHasArrived(string last)
    {
        var lastDay = DateOnly.Parse(last);
        var first = lastDay.AddDays(1);

        // Created on the last day: the cycle due on the 1st is still open.
        await using (var db = NewContext())
        {
            var account = LedgerFixtures.SeedAccount(db, Owner);
            var jar = SeedBill(db, account, due: first);
            LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, lastDay.AddDays(-40));

            var month = await CreateOnAsync(db, lastDay, first.Year, first.Month);

            month.Key.Should().Be($"{first.Year:D4}-{first.Month:D2}");
            month.Categories.SelectMany(c => c.Items).Should().ContainSingle(i => i.SavingsId == jar.Id);
            (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(first);
            (await db.JarCycles.CountAsync()).Should().Be(0);
        }

        // Created on the 1st: the funded cycle has rolled forward a year, stepped from its anchor.
        await using (var db = NewContext())
        {
            var account = LedgerFixtures.SeedAccount(db, Owner);
            var jar = SeedBill(db, account, due: first);
            LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 600m, lastDay.AddDays(-40));

            await CreateOnAsync(db, first, first.Year, first.Month);

            (await db.Jars.SingleAsync()).CycleDeadline.Should().Be(first.AddMonths(12));
            var cycle = await db.JarCycles.SingleAsync();
            cycle.Outcome.Should().Be(JarCycleOutcome.Funded);
            cycle.Deadline.Should().Be(first);
        }
    }

    private static Task<Budgets.Dtos.BudgetMonthDto> CreateOnAsync(ApplicationDbContext db, DateOnly today, int year, int month) =>
        new CreateBudgetMonthCommandHandler(db, new CurrentUserStub(Owner), clock: new FixedClock(today))
            .Handle(new CreateBudgetMonthCommand(year, month, CopyFromPrevious: true), CancellationToken.None);

    // ---- Rule 48: a jar line's balance reads as of today, or the month's end once it is over ---

    [Theory]
    [MemberData(nameof(LastDays))]
    public async Task AJarLine_ReadsMoneyThatArrivesOnThe1st_OnlyFromThe1st(string last)
    {
        var lastDay = DateOnly.Parse(last);
        var first = lastDay.AddDays(1);
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 5000m, TargetDate = first.AddYears(1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 100m, lastDay);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 50m, first, JarAllocationKind.Reallocation);
        var budget = SeedMonth(db, first, jar);
        var lastMonth = SeedMonth(db, new DateOnly(lastDay.Year, lastDay.Month, 1), jar);

        // On the last day the new month has not begun: its line reads what is held today.
        (await LineOnAsync(db, lastDay, budget)).Should().Be(100m);
        // On the 1st the 50 has arrived, and the month that just ended still reads as of its end.
        (await LineOnAsync(db, first, budget)).Should().Be(150m);
        (await LineOnAsync(db, first, lastMonth)).Should().Be(100m);
    }

    private static BudgetMonth SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar)
    {
        var budget = new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 3000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = jar.Name, SavingsId = jar.Id, PlannedAmount = 100m } } },
            },
        };
        db.BudgetMonths.Add(budget);
        db.SaveChanges();
        return budget;
    }

    private static async Task<decimal?> LineOnAsync(ApplicationDbContext db, DateOnly today, BudgetMonth budget)
    {
        var dto = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub(Owner), new FixedClock(today))
            .Handle(new GetBudgetMonthQuery(budget.Year, budget.Month), CancellationToken.None);
        return dto!.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable;
    }
}
