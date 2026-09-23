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

    // ---- Month creation seeds from the anchor, never rewrites it ------------------

    [Fact]
    public async Task CreateMonth_SeedsFromTheRolledDate_WithoutRewritingTheStoredAnchor()
    {
        await using var db = NewContext();
        // Past-due yearly jar: €600 target, due last month, no contributions yet.
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var due = today.AddMonths(-1);
        var jar = Recurring(due);
        db.Jars.Add(jar);
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(today.Year, today.Month, CopyFromPrevious: false),
            CancellationToken.None);

        // The stored anchor is untouched — recurrence is a pure view, never persisted.
        (await db.Jars.SingleAsync()).TargetDate.Should().Be(due);
        // The seeded line spreads over the months to the ROLLED date (11 months out).
        var line = dto.Categories.Single(c => c.Kind == "Savings").Items.Single();
        var monthsToRolled = ((due.AddMonths(12).Year * 12) + due.AddMonths(12).Month)
            - ((today.Year * 12) + today.Month);
        line.PlannedAmount.Should().Be(Math.Round(600m / monthsToRolled, 2, MidpointRounding.AwayFromZero));
    }

    [Theory]
    [InlineData("2026-09-22", "2026-01-31", 1, "2026-09-30")]
    [InlineData("2026-02-15", "2026-01-31", 1, "2026-02-28")]
    [InlineData("2026-03-01", "2026-01-31", 1, "2026-03-31")]
    [InlineData("2026-04-01", "2026-01-31", 1, "2026-04-30")]
    [InlineData("2028-02-15", "2028-01-31", 1, "2028-02-29")]
    [InlineData("2025-02-15", "2024-02-29", 12, "2025-02-28")]
    [InlineData("2028-02-15", "2024-02-29", 12, "2028-02-29")]
    [InlineData("2026-05-01", "2026-01-31", 3, "2026-07-31")]
    public void EffectiveDate_PreservesMonthEndDay_AcrossRolls(
        string today, string anchor, int cycle, string expectedDate)
    {
        // Matching preview cases are exercised through JarsPage's form. A shorter
        // month clamps only that occurrence, never the stored intended day.
        var jar = Recurring(DateOnly.ParseExact(anchor, "yyyy-MM-dd"), recurMonths: cycle);

        JarAccrualCalculator.EffectiveTargetDate(jar, DateOnly.ParseExact(today, "yyyy-MM-dd"))
            .Should().Be(DateOnly.ParseExact(expectedDate, "yyyy-MM-dd"));
        jar.TargetDate.Should().Be(DateOnly.ParseExact(anchor, "yyyy-MM-dd"));
    }

    [Fact]
    public void EffectiveDate_SameMonthLaterDay_RollsToNextCycle()
    {
        // Due the 15th, today is the 20th of the same month: it's passed, so roll.
        var jar = Recurring(new DateOnly(2026, 3, 15), recurMonths: 12);

        JarAccrualCalculator.EffectiveTargetDate(jar, new DateOnly(2026, 3, 20))
            .Should().Be(new DateOnly(2027, 3, 15));
    }

    // ---- Validators --------------------------------------------------------------

    [Fact]
    public void Validator_StaysPermissive_ForDatelessRecurringJars()
    {
        // The "a recurring jar needs a date + target" rule is a form concern, not a
        // server one — so imported/legacy Recurring jars (open-ended pools, date-less
        // funds) remain editable rather than 400-ing on a plain rename.
        var validator = new UpdateJarCommandValidator();

        var pool = validator.Validate(new UpdateJarCommand(
            Guid.NewGuid(), "Living Costs", JarKind.Recurring, 0m, null, null, null,
            AccrualMethod.ProportionalPool, 0m, null, null));

        pool.IsValid.Should().BeTrue();
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
