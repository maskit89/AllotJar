using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The planner behind month seeding, planting and the form's preview: one derivation, so the
/// schedule a user is shown is the one their Savings lines receive (W02), and later months are
/// projected through the plans already saved for the months in between.
/// </summary>
public class JarPlannerTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-planner-{Guid.NewGuid()}")
            .Options);

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly Current = new(Today.Year, Today.Month, 1);

    private static Jar SeedJar(ApplicationDbContext db, Account account, decimal target, DateOnly? due,
        AccrualMethod accrual = AccrualMethod.TargetByDate, decimal? monthly = null)
    {
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Sofa", Kind = JarKind.Goal, TargetAmount = target, TargetDate = due,
            Accrual = accrual, MonthlyContribution = monthly, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static BudgetMonth SeedMonth(ApplicationDbContext db, DateOnly month, decimal income, params (Jar Jar, decimal Planned)[] lines)
    {
        var budget = new BudgetMonth
        {
            OwnerId = "user-1", Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0,
                    Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = income } },
                },
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
                    Items = lines.Select(l => new BudgetItem { Name = l.Jar.Name, PlannedAmount = l.Planned, SavingsId = l.Jar.Id }).ToList(),
                },
            },
        };
        db.BudgetMonths.Add(budget);
        db.SaveChanges();
        return budget;
    }

    private static decimal LineFor(ApplicationDbContext db, Jar jar, DateOnly month) => db.BudgetItems
        .Where(i => i.SavingsId == jar.Id && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month)
        .Select(i => i.PlannedAmount)
        .Single();

    [Fact]
    public async Task ALaterMonth_IsProjectedThroughTheSavedPlansInBetween_NotTheSchedulesOwnFigures()
    {
        // 300 due on the 1st three months out plans 100/100/100 — but this month's line was set to
        // 50 by hand. Creating next month assumes that 50 is kept: (300 − 50) ÷ 2 = 125, not 100.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 300m, Current.AddMonths(3));
        SeedMonth(db, Current, 1000m, (jar, 50m));
        var next = Current.AddMonths(1);

        await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(next.Year, next.Month, CopyFromPrevious: true), CancellationToken.None);

        LineFor(db, jar, next).Should().Be(125m);
    }

    [Fact]
    public async Task ALaterMonth_WithNoMonthsInBetween_UsesTheSchedulesOwnFiguresForTheGap()
    {
        // Nothing budgeted yet; creating the month after next assumes this month and next follow
        // the schedule (100 each), so it plans the final 100 — not the whole 300.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 300m, Current.AddMonths(3));
        var afterNext = Current.AddMonths(2);

        await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(afterNext.Year, afterNext.Month, CopyFromPrevious: false), CancellationToken.None);

        LineFor(db, jar, afterNext).Should().Be(100m);
    }

    [Fact]
    public async Task Rule16_AnOngoingJar_SeedsItsFixedAmount_EveryMonth()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 0m, null, AccrualMethod.FixedMonthly, monthly: 75m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 900m); // however much it already holds

        var dto = await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(Current.Year, Current.Month, CopyFromPrevious: false), CancellationToken.None);

        dto.Categories.Single(c => c.Kind == "Savings").Items.Single().PlannedAmount.Should().Be(75m);
    }

    [Fact]
    public async Task Rule18_AFixedMonthlyTarget_SeedsTheCappedFinalMonth_AndNothingOnceHeld()
    {
        // 250 at 100 a month with 200 already held: this month plans the last 50; holding 250 plans 0.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 250m, null, AccrualMethod.FixedMonthly, monthly: 100m);
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 200m);
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var thisMonth = await handler.Handle(new CreateBudgetMonthCommand(Current.Year, Current.Month, CopyFromPrevious: false), CancellationToken.None);
        thisMonth.Categories.Single(c => c.Kind == "Savings").Items.Single().PlannedAmount.Should().Be(50m);

        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 50m, Current.AddDays(-2));
        var next = Current.AddMonths(1);
        var nextMonth = await handler.Handle(new CreateBudgetMonthCommand(next.Year, next.Month, CopyFromPrevious: false), CancellationToken.None);
        nextMonth.Categories.Single(c => c.Kind == "Savings").Items.Single().PlannedAmount.Should().Be(0m);
    }

    [Fact]
    public async Task ThePreview_IsExactlyWhatCreatingTheJarPlants_AndFlagsAMonthItOverBudgets()
    {
        // This month has 150 of income and nothing planned; next month exists too. A 600 target due
        // on the 1st in three months needs 200 a month: the preview lists 200/200/200, flags this
        // month as 50 over budget (rule 59) and says nothing about the month that has no budget.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        SeedMonth(db, Current, 150m);
        SeedMonth(db, Current.AddMonths(1), 1000m);
        var due = Current.AddMonths(3);

        var preview = await new GetJarScheduleQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarScheduleQuery(null, JarKind.Goal, 600m, due, AccrualMethod.TargetByDate), CancellationToken.None);

        preview.HasSchedule.Should().BeTrue();
        preview.Months.Select(m => m.Planned).Should().Equal(200m, 200m, 200m);
        preview.Total.Should().Be(600m);
        preview.Deadline.Should().Be(due);
        preview.FundingCompletesOn.Should().Be(due.AddDays(-1));
        preview.Months[0].Shortfall.Should().Be(50m);
        preview.Months[1].Shortfall.Should().Be(0m);
        preview.Months[2].HasBudget.Should().BeFalse();
        preview.Months[2].Shortfall.Should().BeNull();

        var created = await new CreateJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateJarCommand("Sofa", JarKind.Goal, 600m, due, AccrualMethod.TargetByDate, account.Id), CancellationToken.None);

        var jar = await db.Jars.SingleAsync(j => j.Id == created.Id);
        LineFor(db, jar, Current).Should().Be(preview.Months[0].Planned);
        LineFor(db, jar, Current.AddMonths(1)).Should().Be(preview.Months[1].Planned);
        created.PlannedThisMonth.Should().Be(preview.Months[0].Planned);
    }

    [Fact]
    public async Task ThePreview_OfAnEdit_StartsFromTheJarsBalanceEnteringTheMonth_AndOfANewJar_FromWhatIsSetAside()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 300m, Current.AddMonths(3));
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 90m, Current.AddDays(-1));
        var handler = new GetJarScheduleQueryHandler(db, new CurrentUserStub("user-1"));

        // Editing: 300 − 90 held = 210 over three months → 70 each.
        var edit = await handler.Handle(
            new GetJarScheduleQuery(jar.Id, JarKind.Goal, 300m, Current.AddMonths(3), AccrualMethod.TargetByDate), CancellationToken.None);
        edit.Balance.Should().Be(90m);
        edit.Months.Select(m => m.Planned).Should().Equal(70m, 70m, 70m);

        // A new jar with 60 being set aside: 240 over three months → 80 each.
        var fresh = await handler.Handle(
            new GetJarScheduleQuery(null, JarKind.Goal, 300m, Current.AddMonths(3), AccrualMethod.TargetByDate, InitialAllocation: 60m), CancellationToken.None);
        fresh.Balance.Should().Be(60m);
        fresh.Months.Select(m => m.Planned).Should().Equal(80m, 80m, 80m);

        // A fixed monthly target reports its estimate, an ongoing jar its one repeating month.
        var fixedPlan = await handler.Handle(
            new GetJarScheduleQuery(null, JarKind.Goal, 1000m, null, AccrualMethod.FixedMonthly, MonthlyContribution: 100m, InitialAllocation: 400m), CancellationToken.None);
        fixedPlan.EstimatedMonths.Should().Be(6);
        fixedPlan.Deadline.Should().BeNull();
        var ongoing = await handler.Handle(
            new GetJarScheduleQuery(null, JarKind.Goal, 0m, null, AccrualMethod.FixedMonthly, MonthlyContribution: 100m), CancellationToken.None);
        ongoing.IsOngoing.Should().BeTrue();
        ongoing.Months.Should().ContainSingle().Which.Planned.Should().Be(100m);
    }

    [Fact]
    public async Task ThePreview_OfAnotherHouseholdsJar_IsForbidden()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = SeedJar(db, account, 300m, Current.AddMonths(3));

        var act = () => new GetJarScheduleQueryHandler(db, new CurrentUserStub("user-2"))
            .Handle(new GetJarScheduleQuery(jar.Id, JarKind.Goal, 300m, Current.AddMonths(3), AccrualMethod.TargetByDate), CancellationToken.None);

        await act.Should().ThrowAsync<AllotJar.Application.Common.Exceptions.ForbiddenAccessException>();
    }
}
