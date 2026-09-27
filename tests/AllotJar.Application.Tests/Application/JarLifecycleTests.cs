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
/// The Type lifecycle through the handlers and DTO: a Recurring jar re-arms each cycle and
/// reads OnTrack past its anchor, a Goal's date never rolls (Behind past its date), the cycle
/// length follows the Kind, and the schedule rules apply on edit. The date arithmetic itself
/// is covered by Domain/JarScheduleTests.
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
    public void Status_PastDueRecurring_ReadsOnTrack_NotBehind()
    {
        var jar = Recurring(new DateOnly(2026, 3, 1));

        var dto = jar.ToDto(currentBalance: 100m, balanceAtMonthStart: 100m, storedPlanThisMonth: null, asOf: new DateOnly(2026, 7, 6));

        dto.Status.Should().Be("OnTrack");
        // The DTO carries the stored ANCHOR, not the rolled date — an edit round-trips
        // faithfully rather than silently advancing the date. Recurrence shows up in
        // the status (OnTrack, not Behind), computed from the effective date internally.
        dto.TargetDate.Should().Be(new DateOnly(2026, 3, 1));
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
        goal.RecurMonths.Should().BeNull(); // forced null for Goals, whatever was sent
    }

    [Fact]
    public async Task Update_SwitchingToGoal_ClearsTheCycle()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = Recurring(new DateOnly(2026, 10, 1), accountId: account.Id);
        db.Jars.Add(jar);
        db.SaveChanges();
        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(new UpdateJarCommand(
            jar.Id, "Insurance", JarKind.Goal, 600m, new DateOnly(2026, 10, 1),
            AccrualMethod.TargetByDate, account.Id), CancellationToken.None);

        dto.RecurMonths.Should().BeNull();
    }

    // ---- Month creation seeds from the anchor, never rewrites it ------------------

    [Fact]
    public async Task CreateMonth_SeedsFromTheRolledDate_WithoutRewritingTheStoredAnchor()
    {
        await using var db = NewContext();
        // Past-due yearly jar: €600 target, due last month, no contributions yet.
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var due = today.AddMonths(-1);
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = Recurring(due, accountId: account.Id);
        db.Jars.Add(jar);
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(today.Year, today.Month, CopyFromPrevious: false),
            CancellationToken.None);

        // The stored anchor is untouched — recurrence is a pure view, never persisted.
        (await db.Jars.SingleAsync()).TargetDate.Should().Be(due);
        // The seeded line spreads over the months up to the ROLLED date: from this month to the
        // month before it (rule 12), in whole cents with the remainder in the last month (rule 35).
        var line = dto.Categories.Single(c => c.Kind == "Savings").Items.Single();
        var rolled = due.AddMonths(12);
        var months = ((rolled.Year * 12) + rolled.Month) - ((today.Year * 12) + today.Month);
        line.PlannedAmount.Should().Be(Math.Floor(600m / months * 100m) / 100m);
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
