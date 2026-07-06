using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The Type lifecycle: a Recurring jar's target date rolls forward by RecurMonths
/// once it passes (the jar re-arms each cycle); a Goal's date never rolls — it
/// completes at its target or reads Behind past its date.
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

    private static Jar Recurring(DateOnly? due, int? recurMonths = 12, decimal target = 600m) => new()
    {
        OwnerId = "user-1", Name = "Insurance", Kind = JarKind.Recurring,
        TargetAmount = target, TargetDate = due, Accrual = AccrualMethod.TargetByDate,
        RecurMonths = recurMonths,
    };

    // ---- EffectiveTargetDate -------------------------------------------------

    [Fact]
    public void EffectiveDate_RollsAPassedRecurringDate_ForwardByCycle()
    {
        var jar = Recurring(new DateOnly(2026, 3, 1));

        JarAccrualCalculator.EffectiveTargetDate(jar, new DateOnly(2026, 7, 6))
            .Should().Be(new DateOnly(2027, 3, 1));
    }

    [Fact]
    public void EffectiveDate_RollsAcrossMultipleMissedCycles()
    {
        var jar = Recurring(new DateOnly(2024, 5, 1), recurMonths: 6);

        // 2024-05 → 2024-11 → 2025-05 → 2025-11 → 2026-05 → 2026-11.
        JarAccrualCalculator.EffectiveTargetDate(jar, new DateOnly(2026, 7, 6))
            .Should().Be(new DateOnly(2026, 11, 1));
    }

    [Fact]
    public void EffectiveDate_LeavesFutureDates_AndGoals_Untouched()
    {
        var future = Recurring(new DateOnly(2026, 12, 1));
        JarAccrualCalculator.EffectiveTargetDate(future, new DateOnly(2026, 7, 6))
            .Should().Be(new DateOnly(2026, 12, 1));

        var goal = new Jar
        {
            Kind = JarKind.Goal, TargetAmount = 900m, TargetDate = new DateOnly(2026, 3, 1),
        };
        JarAccrualCalculator.EffectiveTargetDate(goal, new DateOnly(2026, 7, 6))
            .Should().Be(new DateOnly(2026, 3, 1));
    }

    [Fact]
    public void EffectiveDate_DueToday_DoesNotRoll()
    {
        var jar = Recurring(new DateOnly(2026, 7, 6));

        JarAccrualCalculator.EffectiveTargetDate(jar, new DateOnly(2026, 7, 6))
            .Should().Be(new DateOnly(2026, 7, 6));
    }

    // ---- Accrual over the rolled date -----------------------------------------

    [Fact]
    public void TargetByDate_SpreadsOverTheNextCycle_AfterTheDatePasses()
    {
        // Due March, it's July: rolled to next March = 8 months away; 600 ÷ 8 = 75.
        var jar = Recurring(new DateOnly(2026, 3, 1));

        JarAccrualCalculator.TargetByDate(jar, new DateOnly(2026, 7, 1), currentBalance: 0m)
            .Should().Be(75.00m);
    }

    // ---- Status ----------------------------------------------------------------

    [Fact]
    public void Status_PastDueRecurring_ReadsOnTrack_NotBehind()
    {
        var jar = Recurring(new DateOnly(2026, 3, 1));

        var dto = jar.ToDto(currentBalance: 100m, requiredMonthly: 75m, asOf: new DateOnly(2026, 7, 6));

        dto.Status.Should().Be("OnTrack");
        // And the DTO carries the rolled date, not the stale one.
        dto.TargetDate.Should().Be(new DateOnly(2027, 3, 1));
    }

    [Fact]
    public void Status_PastDueGoal_StaysBehind()
    {
        var goal = new Jar
        {
            Kind = JarKind.Goal, TargetAmount = 900m, TargetDate = new DateOnly(2026, 3, 1),
        };

        var dto = goal.ToDto(currentBalance: 100m, requiredMonthly: 800m, asOf: new DateOnly(2026, 7, 6));

        dto.Status.Should().Be("Behind");
        dto.TargetDate.Should().Be(new DateOnly(2026, 3, 1));
    }

    [Fact]
    public void Status_FundedGoal_ReadsFullyFunded()
    {
        var goal = new Jar { Kind = JarKind.Goal, TargetAmount = 900m };

        goal.ToDto(currentBalance: 900m, requiredMonthly: 0m, asOf: new DateOnly(2026, 7, 6))
            .Status.Should().Be("FullyFunded");
    }

    // ---- Handlers keep RecurMonths in lockstep with Kind ------------------------

    [Fact]
    public async Task Create_StoresCycle_ForRecurring_AndNullsIt_ForGoal()
    {
        await using var db = NewContext();
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var recurring = await handler.Handle(new CreateJarCommand(
            "Road Tax", JarKind.Recurring, 150m, new DateOnly(2026, 10, 1), null, null,
            AccrualMethod.TargetByDate, 0m, null, null, RecurMonths: 6), CancellationToken.None);
        var goal = await handler.Handle(new CreateJarCommand(
            "Sofa", JarKind.Goal, 1200m, null, null, null,
            AccrualMethod.TargetByDate, 0m, null, null, RecurMonths: 6), CancellationToken.None);

        recurring.RecurMonths.Should().Be(6);
        goal.RecurMonths.Should().BeNull(); // forced null for Goals, whatever was sent
    }

    [Fact]
    public async Task Update_SwitchingToGoal_ClearsTheCycle()
    {
        await using var db = NewContext();
        var jar = Recurring(new DateOnly(2026, 10, 1));
        db.Jars.Add(jar);
        db.SaveChanges();
        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(new UpdateJarCommand(
            jar.Id, "Insurance", JarKind.Goal, 600m, new DateOnly(2026, 10, 1), null, null,
            AccrualMethod.TargetByDate, 0m, null, null), CancellationToken.None);

        dto.RecurMonths.Should().BeNull();
    }

    // ---- Month creation persists the roll ---------------------------------------

    [Fact]
    public async Task CreateMonth_PersistsRollsDueToday_ButNeverSkipsFutureCycles()
    {
        await using var db = NewContext();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // Past-due: rolls forward past today. Future-due: must NOT roll, even when
        // the month being created lies beyond it.
        var pastDue = Recurring(today.AddMonths(-2));
        var futureDue = Recurring(today.AddMonths(1));
        futureDue.Name = "Future";
        db.Jars.AddRange(pastDue, futureDue);
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var far = today.AddMonths(4);
        await handler.Handle(
            new CreateBudgetMonthCommand(far.Year, far.Month, CopyFromPrevious: false),
            CancellationToken.None);

        (await db.Jars.SingleAsync(f => f.Id == pastDue.Id)).TargetDate
            .Should().Be(today.AddMonths(-2).AddMonths(12));
        (await db.Jars.SingleAsync(f => f.Id == futureDue.Id)).TargetDate
            .Should().Be(today.AddMonths(1), "cycles still ahead of today must not be skipped");
    }

    // ---- Validators --------------------------------------------------------------

    [Fact]
    public void Validator_RequiresDateAndTarget_ForRecurring()
    {
        var validator = new CreateJarCommandValidator();

        var noDate = validator.Validate(new CreateJarCommand(
            "X", JarKind.Recurring, 100m, null, null, null,
            AccrualMethod.TargetByDate, 0m, null, null));
        noDate.Errors.Should().Contain(e => e.ErrorMessage == "A recurring jar needs its next due date.");

        var noTarget = validator.Validate(new CreateJarCommand(
            "X", JarKind.Recurring, 0m, new DateOnly(2026, 10, 1), null, null,
            AccrualMethod.TargetByDate, 0m, null, null));
        noTarget.Errors.Should().Contain(e => e.ErrorMessage == "A recurring jar needs a target amount.");

        var goalWithoutEither = validator.Validate(new CreateJarCommand(
            "X", JarKind.Goal, 0m, null, null, null,
            AccrualMethod.TargetByDate, 0m, null, null));
        goalWithoutEither.IsValid.Should().BeTrue("goals stay open-ended");
    }

    [Fact]
    public void Validator_BoundsTheRepeatCycle()
    {
        var validator = new CreateJarCommandValidator();

        validator.Validate(new CreateJarCommand(
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1), null, null,
                AccrualMethod.TargetByDate, 0m, null, null, RecurMonths: 0))
            .Errors.Should().Contain(e => e.ErrorMessage == "Repeat cycle must be between 1 and 120 months.");
    }
}
