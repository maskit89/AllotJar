using FluentAssertions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using Xunit;

namespace AllotJar.Application.Tests.Domain;

/// <summary>
/// The contribution schedule against the confirmed examples in AGREED-RULES (12–13, 16–18,
/// 35–36, 58, 62): the planner behind the preview, month seeding and the Jars page.
/// </summary>
public class JarScheduleTests
{
    private static Jar ByDeadline(decimal target, DateOnly deadline, bool includeDeadlineMonth = false,
        JarKind kind = JarKind.Goal, int? recurMonths = null) => new()
    {
        Name = "Test", Kind = kind, TargetAmount = target, TargetDate = deadline,
        Accrual = AccrualMethod.TargetByDate, IncludeDeadlineMonth = includeDeadlineMonth,
        RecurMonths = kind == JarKind.Recurring ? recurMonths ?? 12 : null,
    };

    private static Jar FixedMonthly(decimal monthly, decimal target = 0m) => new()
    {
        Name = "Test", Kind = JarKind.Goal, TargetAmount = target, Accrual = AccrualMethod.FixedMonthly,
        MonthlyContribution = monthly,
    };

    private static decimal[] Planned(JarPlan plan) => plan.Months.Select(m => m.Planned).ToArray();

    // ---- Deadline plans (rules 12, 13, 35, 36) ----------------------------------------

    [Fact]
    public void Rule12_ADeadlineOnTheFirst_PlansTheMonthsBeforeIt()
    {
        // Created in September with nothing saved, 300 due 1 December: 100 in Sep, Oct, Nov.
        var plan = JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 1)), new DateOnly(2026, 9, 22), 0m);

        Planned(plan).Should().Equal(100m, 100m, 100m);
        plan.Months.Select(m => m.Month).Should().Equal(9, 10, 11);
        plan.FundingCompletesOn.Should().Be(new DateOnly(2026, 11, 30));
        plan.Deadline.Should().Be(new DateOnly(2026, 12, 1));
        plan.Total.Should().Be(300m);
    }

    [Fact]
    public void Rule13_TheNextMonth_RecalculatesFromWhatWasActuallySaved()
    {
        // Only 50 saved by the end of September leaves 250 over October and November: 125 each.
        var plan = JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 1)), new DateOnly(2026, 10, 1), 50m);

        Planned(plan).Should().Equal(125m, 125m);
        plan.Remaining.Should().Be(250m);
    }

    [Fact]
    public void Rule14_ThisMonthsPlan_ComesFromTheBalanceEnteringTheMonth()
    {
        // October's plan is 125 whatever lands during October; the caller passes the month-start balance.
        JarSchedule.PlannedFor(ByDeadline(300m, new DateOnly(2026, 12, 1)), new DateOnly(2026, 10, 20), 50m).Should().Be(125m);
    }

    [Fact]
    public void Rule35_TheRoundingRemainder_GoesIntoTheFinalMonth_SoThePlanSumsExactly()
    {
        // 100 over three months: 33.33, 33.33, 33.34 — never a fourth month for the last cent.
        var plan = JarSchedule.Plan(ByDeadline(100m, new DateOnly(2026, 12, 22)), new DateOnly(2026, 9, 22), 0m);

        Planned(plan).Should().Equal(33.33m, 33.33m, 33.34m);
        plan.Total.Should().Be(100m);
        plan.FundingCompletesOn.Should().Be(new DateOnly(2026, 11, 30));
    }

    [Fact]
    public void Rule35_RecalculatingFromActualSavings_KeepsTheExactTotal()
    {
        // 33.33 saved in September: 66.67 left over October and November → 33.33, 33.34.
        var plan = JarSchedule.Plan(ByDeadline(100m, new DateOnly(2026, 12, 22)), new DateOnly(2026, 10, 1), 33.33m);

        Planned(plan).Should().Equal(33.33m, 33.34m);
        plan.Total.Should().Be(66.67m);
    }

    [Fact]
    public void Rule35_ATinyRemainder_NeverPlansANegativeMonth()
    {
        // 0.06 over twelve months: eleven months of 0.00 and the 0.06 in the last.
        var plan = JarSchedule.Plan(ByDeadline(0.06m, new DateOnly(2027, 10, 1)), new DateOnly(2026, 10, 1), 0m);

        plan.Months.Should().HaveCount(12);
        plan.Months.Take(11).Should().OnlyContain(m => m.Planned == 0m);
        plan.Months[^1].Planned.Should().Be(0.06m);
    }

    [Fact]
    public void Rule36_AMidMonthDeadline_CompletesTheMonthBefore_ByDefault()
    {
        // 300 by 15 December from September: 100 in Sep/Oct/Nov; funding completes 30 Nov, the deadline stays 15 Dec.
        var plan = JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 15)), new DateOnly(2026, 9, 1), 0m);

        Planned(plan).Should().Equal(100m, 100m, 100m);
        plan.FundingCompletesOn.Should().Be(new DateOnly(2026, 11, 30));
        plan.Deadline.Should().Be(new DateOnly(2026, 12, 15));
    }

    [Fact]
    public void Rule36_IncludingTheDeadlineMonth_SpreadsOverItToo()
    {
        var plan = JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 15), includeDeadlineMonth: true), new DateOnly(2026, 9, 1), 0m);

        Planned(plan).Should().Equal(75m, 75m, 75m, 75m);
        plan.FundingCompletesOn.Should().Be(new DateOnly(2026, 12, 31));
        plan.Deadline.Should().Be(new DateOnly(2026, 12, 15));
    }

    [Fact]
    public void Rule36_TheOptIn_MeansNothing_ForADeadlineOnTheFirst()
    {
        // Nothing can reach the account on 1 December before 1 December: still Sep/Oct/Nov.
        var plan = JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 1), includeDeadlineMonth: true), new DateOnly(2026, 9, 1), 0m);

        Planned(plan).Should().Equal(100m, 100m, 100m);
    }

    [Fact]
    public void ADeadlineThisMonth_OrPassed_DemandsTheWholeRemainderNow()
    {
        // Due the 20th of this month with nothing saved, no months are left: 500 now.
        JarSchedule.Plan(ByDeadline(500m, new DateOnly(2026, 1, 20)), new DateOnly(2026, 1, 5), 0m).Months
            .Should().ContainSingle().Which.Planned.Should().Be(500m);
        // A Goal past its deadline never rolls: the remainder is due now and the Goal reads Behind.
        var passed = JarSchedule.Plan(ByDeadline(900m, new DateOnly(2026, 3, 1)), new DateOnly(2026, 7, 6), 100m);
        Planned(passed).Should().Equal(800m);
        passed.Deadline.Should().Be(new DateOnly(2026, 3, 1));
    }

    [Fact]
    public void AFundedDeadlineJar_PlansNothing()
    {
        var plan = JarSchedule.Plan(ByDeadline(1200m, new DateOnly(2026, 11, 1)), new DateOnly(2026, 1, 1), 1200m);

        plan.Months.Should().BeEmpty();
        plan.Remaining.Should().Be(0m);
        plan.FundingCompletesOn.Should().BeNull();
        JarSchedule.PlannedFor(ByDeadline(1200m, new DateOnly(2026, 11, 1)), new DateOnly(2026, 1, 1), 1250m).Should().Be(0m);
    }

    [Fact]
    public void AnOverspentJar_PlansTheShortfallTooIntoTheRemainingMonths()
    {
        // −40 held toward 300 due 1 Dec from October: 340 over Oct/Nov = 170 each.
        Planned(JarSchedule.Plan(ByDeadline(300m, new DateOnly(2026, 12, 1)), new DateOnly(2026, 10, 1), -40m))
            .Should().Equal(170m, 170m);
    }

    // ---- Recurring deadlines (rules 21 view, 62) --------------------------------------

    [Fact]
    public void ARecurringJar_PlansTowardItsNextCycle_OnceTheDateHasPassed()
    {
        // Due 1 March yearly, it's July: the next cycle is 1 March 2027, eight months (Jul–Feb) → 75 each.
        var jar = ByDeadline(600m, new DateOnly(2026, 3, 1), kind: JarKind.Recurring, recurMonths: 12);
        var plan = JarSchedule.Plan(jar, new DateOnly(2026, 7, 1), 0m);

        plan.Deadline.Should().Be(new DateOnly(2027, 3, 1));
        plan.Months.Should().HaveCount(8);
        Planned(plan).Should().OnlyContain(p => p == 75m);
        jar.TargetDate.Should().Be(new DateOnly(2026, 3, 1)); // the anchor is never rewritten
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
    public void Rule62_AShorterMonth_ClampsOnlyThatOccurrence_AndKeepsTheIntendedDay(
        string today, string anchor, int cycle, string expectedDate)
    {
        var jar = ByDeadline(100m, DateOnly.ParseExact(anchor, "yyyy-MM-dd"), kind: JarKind.Recurring, recurMonths: cycle);

        JarSchedule.EffectiveDeadline(jar, DateOnly.ParseExact(today, "yyyy-MM-dd"))
            .Should().Be(DateOnly.ParseExact(expectedDate, "yyyy-MM-dd"));
        jar.TargetDate.Should().Be(DateOnly.ParseExact(anchor, "yyyy-MM-dd"));
    }

    [Fact]
    public void EffectiveDeadline_DueToday_DoesNotRoll_ButALaterDayThisMonth_Does()
    {
        var jar = ByDeadline(100m, new DateOnly(2026, 3, 15), kind: JarKind.Recurring, recurMonths: 12);

        JarSchedule.EffectiveDeadline(jar, new DateOnly(2026, 3, 15)).Should().Be(new DateOnly(2026, 3, 15));
        JarSchedule.EffectiveDeadline(jar, new DateOnly(2026, 3, 20)).Should().Be(new DateOnly(2027, 3, 15));
        // A future date is left alone; several missed cycles are jumped in one go, from the anchor.
        JarSchedule.EffectiveDeadline(jar, new DateOnly(2025, 7, 1)).Should().Be(new DateOnly(2026, 3, 15));
        JarSchedule.EffectiveDeadline(ByDeadline(100m, new DateOnly(2024, 3, 1), kind: JarKind.Recurring, recurMonths: 12), new DateOnly(2026, 7, 1))
            .Should().Be(new DateOnly(2027, 3, 1));
        // Goals never roll, nor does a jar without a date have a deadline.
        JarSchedule.EffectiveDeadline(ByDeadline(100m, new DateOnly(2026, 3, 1)), new DateOnly(2026, 7, 1)).Should().Be(new DateOnly(2026, 3, 1));
        JarSchedule.EffectiveDeadline(FixedMonthly(50m), new DateOnly(2026, 7, 1)).Should().BeNull();
    }

    // ---- Fixed monthly plans (rules 16, 17, 18, 58) -----------------------------------

    [Fact]
    public void Rule16_AnOngoingJar_PlansItsFixedAmountEveryMonth_AndNeverEnds()
    {
        var jar = FixedMonthly(100m);

        var plan = JarSchedule.Plan(jar, new DateOnly(2026, 9, 1), 4000m);
        plan.IsOngoing.Should().BeTrue();
        Planned(plan).Should().Equal(100m);
        plan.Remaining.Should().Be(0m);
        plan.EstimatedMonths.Should().BeNull();
        // Missing a month never raises a later month (the plan is fixed, not recalculated).
        JarSchedule.PlannedFor(jar, new DateOnly(2026, 10, 1), 0m).Should().Be(100m);
        JarSchedule.IsOngoing(jar).Should().BeTrue();
    }

    [Fact]
    public void Rule18_AFixedMonthlyTarget_CapsTheFinalMonth_AndStopsOnceReached()
    {
        // 250 at 100 a month: 100, 100, 50; nothing once 250 is actually held.
        var jar = FixedMonthly(100m, target: 250m);

        Planned(JarSchedule.Plan(jar, new DateOnly(2026, 9, 1), 0m)).Should().Equal(100m, 100m, 50m);
        JarSchedule.Plan(jar, new DateOnly(2026, 9, 1), 250m).Months.Should().BeEmpty();
        JarSchedule.PlannedFor(jar, new DateOnly(2026, 9, 1), 230m).Should().Be(20m);
    }

    [Fact]
    public void Rule58_AFixedMonthlyTarget_EstimatesTheMonthsStillNeeded_WithNoDeadline()
    {
        // Target 1,000, 400 held, 100 a month: about six more contributions.
        var plan = JarSchedule.Plan(FixedMonthly(100m, target: 1000m), new DateOnly(2026, 9, 1), 400m);

        plan.EstimatedMonths.Should().Be(6);
        plan.Deadline.Should().BeNull();
        plan.FundingCompletesOn.Should().BeNull();
        plan.Total.Should().Be(600m);
    }

    [Fact]
    public void AFixedMonthlyPlan_ListsAtMostTenYears_ButEstimatesTheWholeSpan()
    {
        var plan = JarSchedule.Plan(FixedMonthly(1m, target: 2000m), new DateOnly(2026, 9, 1), 0m);

        plan.Months.Should().HaveCount(JarSchedule.MaxListedMonths);
        plan.EstimatedMonths.Should().Be(2000);
    }

    // ---- No usable plan (rule 17) -------------------------------------------------------

    [Fact]
    public void Rule17_AJarWithoutADeadlineOrAFixedAmount_PlansNothing_NoTwelveMonthDefault()
    {
        var dateless = new Jar { Kind = JarKind.Goal, TargetAmount = 1200m, Accrual = AccrualMethod.TargetByDate };
        var noAmount = new Jar { Kind = JarKind.Goal, TargetAmount = 1200m, Accrual = AccrualMethod.FixedMonthly };
        var noTarget = new Jar { Kind = JarKind.Goal, TargetAmount = 0m, Accrual = AccrualMethod.TargetByDate, TargetDate = new DateOnly(2026, 12, 1) };

        foreach (var jar in new[] { dateless, noAmount, noTarget })
        {
            JarSchedule.HasSchedule(jar).Should().BeFalse();
            JarSchedule.Plan(jar, new DateOnly(2026, 1, 1), 0m).Months.Should().BeEmpty();
        }
        JarSchedule.Plan(dateless, new DateOnly(2026, 1, 1), 200m).Remaining.Should().Be(1000m);
    }
}
