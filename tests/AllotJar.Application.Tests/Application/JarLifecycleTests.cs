using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The Type lifecycle through the handlers and DTO: a Recurring jar saves toward its open
/// cycle and reads Deadline missed past it (W03), a Goal's date never rolls (Behind past its
/// date), the cycle length follows the Kind, and the schedule rules apply on edit. The date
/// arithmetic itself is covered by Domain/JarScheduleTests; closing cycles by JarCycleTests.
/// </summary>
public class JarLifecycleTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    private static Jar Recurring(DateOnly? due, int? recurMonths = 12, decimal target = 600m, Guid? accountId = null) => new()
    {
        OwnerId = "user-1", Name = "Insurance", Kind = JarKind.Recurring,
        TargetAmount = target, TargetDate = due, Accrual = AccrualMethod.TargetByDate,
        RecurMonths = recurMonths, FundingAccountId = accountId ?? Guid.Empty,
    };

    // ---- Status ----------------------------------------------------------------

    [Fact]
    public void Status_PastDueRecurring_ReadsDeadlineMissed_WithTheShortfall_ThenFundedLate()
    {
        // Rule 20: 450 held against 600 due 1 March, read in July with the cycle still open —
        // Deadline missed, 150 short, the whole 150 planned now. Rule 57: once the target is
        // reached the notice stays (Funded late, nothing short) until the user dismisses it.
        var jar = Recurring(new DateOnly(2026, 3, 1));
        jar.CycleDeadline = new DateOnly(2026, 3, 1);

        var dto = jar.ToDto(currentBalance: 450m, balanceAtMonthStart: 450m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6));
        dto.Status.Should().Be("DeadlineMissed");
        dto.Shortfall.Should().Be(150m);
        dto.Deadline.Should().Be(new DateOnly(2026, 3, 1));
        dto.PlannedThisMonth.Should().Be(150m);
        // The DTO carries the stored ANCHOR, so an edit round-trips faithfully.
        dto.TargetDate.Should().Be(new DateOnly(2026, 3, 1));

        var late = jar.ToDto(currentBalance: 600m, balanceAtMonthStart: 450m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6));
        late.Status.Should().Be("FundedLate");
        late.Shortfall.Should().Be(0m);

        // An open cycle still ahead reads OnTrack, and carries no shortfall.
        jar.CycleDeadline = new DateOnly(2027, 3, 1);
        var ahead = jar.ToDto(currentBalance: 450m, balanceAtMonthStart: 450m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6));
        ahead.Status.Should().Be("OnTrack");
        ahead.Shortfall.Should().BeNull();
        ahead.Deadline.Should().Be(new DateOnly(2027, 3, 1));
    }

    [Fact]
    public void Status_PastDueGoal_StaysBehind()
    {
        var goal = new Jar
        {
            Kind = JarKind.Goal, TargetAmount = 900m, TargetDate = new DateOnly(2026, 3, 1),
        };

        var dto = goal.ToDto(currentBalance: 100m, balanceAtMonthStart: 100m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6));

        dto.Status.Should().Be("Behind");
        dto.TargetDate.Should().Be(new DateOnly(2026, 3, 1));
    }

    [Fact]
    public void Status_FundedGoal_ReadsFullyFunded()
    {
        var goal = new Jar { Kind = JarKind.Goal, TargetAmount = 900m };

        goal.ToDto(currentBalance: 900m, balanceAtMonthStart: 900m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6))
            .Status.Should().Be("FullyFunded");
    }

    // ---- Handlers keep RecurMonths in lockstep with Kind ------------------------

    [Fact]
    public async Task Create_StoresCycle_ForRecurring_AndNullsIt_ForGoal()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var recurring = await handler.Handle(new CreateJarCommand(
            "Road Tax", JarKind.Recurring, 150m, new DateOnly(2026, 10, 1),
            AccrualMethod.TargetByDate, account.Id, RecurMonths: 6), CancellationToken.None);
        var goal = await handler.Handle(new CreateJarCommand(
            "Sofa", JarKind.Goal, 1200m, null,
            AccrualMethod.TargetByDate, account.Id, RecurMonths: 6), CancellationToken.None);

        recurring.RecurMonths.Should().Be(6);
        recurring.Deadline.Should().Be(new DateOnly(2026, 10, 1)); // the first cycle opens on the date given (W03)
        (await db.Jars.SingleAsync(j => j.Id == recurring.Id)).CycleDeadline.Should().Be(new DateOnly(2026, 10, 1));
        goal.RecurMonths.Should().BeNull(); // forced null for Goals, whatever was sent
        (await db.Jars.SingleAsync(j => j.Id == goal.Id)).CycleDeadline.Should().BeNull();
    }

    [Fact]
    public async Task Update_SwitchingToGoal_ClearsTheCycle()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = Recurring(new DateOnly(2026, 10, 1), accountId: account.Id);
        jar.CycleDeadline = new DateOnly(2026, 10, 1);
        db.Jars.Add(jar);
        db.SaveChanges();
        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(new UpdateJarCommand(
            jar.Id, "Insurance", JarKind.Goal, 600m, new DateOnly(2026, 10, 1),
            AccrualMethod.TargetByDate, account.Id), CancellationToken.None);

        dto.RecurMonths.Should().BeNull();
        (await db.Jars.SingleAsync()).CycleDeadline.Should().BeNull();
    }

    // ---- Month creation plans toward the open cycle, never rewrites the anchor ------

    [Fact]
    public async Task CreateMonth_PlansAFundedCycleTowardTheNextDeadline_AndAMissedOneInFull_WithoutRewritingTheAnchor()
    {
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var due = today.AddMonths(-1);
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 2000m);
        // Two yearly €600 jars due last month: one held its target in time, one held nothing.
        var funded = Recurring(due, accountId: account.Id);
        funded.Name = "Funded";
        funded.CycleDeadline = due;
        var missed = Recurring(due, accountId: account.Id);
        missed.Name = "Missed";
        missed.CycleDeadline = due;
        db.Jars.AddRange(funded, missed);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, "user-1", account.Id, funded.Id, 600m, due.AddDays(-10));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(today.Year, today.Month, CopyFromPrevious: false),
            CancellationToken.None);

        // Both anchors are untouched. The funded jar rolled forward (rule 21) and, still holding
        // its 600, plans nothing; the missed one stays on its passed deadline (rule 20) and plans
        // the whole 600 now.
        var jars = await db.Jars.ToListAsync();
        jars.Should().OnlyContain(j => j.TargetDate == due);
        jars.Single(j => j.Id == funded.Id).CycleDeadline.Should().Be(due.AddMonths(12));
        jars.Single(j => j.Id == missed.Id).CycleDeadline.Should().Be(due);
        var lines = dto.Categories.Single(c => c.Kind == "Savings").Items;
        lines.Single(i => i.Name == "Funded").PlannedAmount.Should().Be(0m);
        lines.Single(i => i.Name == "Missed").PlannedAmount.Should().Be(600m);
    }

    // ---- Validators --------------------------------------------------------------

    [Fact]
    public void Validator_RequiresADeadlinePlan_ForARecurringJar_AndAPlan_ForAGoal()
    {
        // Rule 17 on edit as on create: a date-less recurring jar cannot be saved (nothing to roll,
        // no twelve-month default), a Goal needs a deadline or a fixed monthly amount, and a fixed
        // monthly plan carries no deadline.
        var validator = new UpdateJarCommandValidator();

        validator.Validate(new UpdateJarCommand(
                Guid.NewGuid(), "Living Costs", JarKind.Recurring, 600m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid()))
            .Errors.Should().Contain(e => e.ErrorMessage == "Give the jar a deadline, or save a fixed amount each month instead.");
        validator.Validate(new UpdateJarCommand(
                Guid.NewGuid(), "Sofa", JarKind.Goal, 900m, new DateOnly(2027, 3, 1),
                AccrualMethod.FixedMonthly, Guid.NewGuid(), MonthlyContribution: 100m))
            .Errors.Should().Contain(e => e.ErrorMessage == "A fixed monthly plan has no deadline. Remove the date, or save by the deadline instead.");
        validator.Validate(new UpdateJarCommand(
                Guid.NewGuid(), "Sofa", JarKind.Goal, 900m, null,
                AccrualMethod.FixedMonthly, Guid.NewGuid(), MonthlyContribution: 100m))
            .IsValid.Should().BeTrue();
    }

    [Fact]
    public void Validator_BoundsTheRepeatCycle()
    {
        var validator = new CreateJarCommandValidator();

        validator.Validate(new CreateJarCommand(
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1),
                AccrualMethod.TargetByDate, Guid.NewGuid(), RecurMonths: 0))
            .Errors.Should().Contain(e => e.ErrorMessage == "Repeat cycle must be between 1 and 120 months.");
    }
}
