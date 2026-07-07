using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>
/// Pure (no I/O) calculator for a <see cref="Jar"/>'s required monthly
/// contribution and for prorating an opening balance. Kept dependency-free so it can
/// be unit-tested directly against the figures in the source spreadsheet.
///
/// All results round to 2 decimal places half-away-from-zero to match Excel's ROUND,
/// so the app reconciles to the spreadsheet to the cent.
/// </summary>
public static class JarAccrualCalculator
{
    private static decimal Round2(decimal value) => Math.Round(value, 2, MidpointRounding.AwayFromZero);

    /// <summary>
    /// The amount to put into the jar this month, per its <see cref="Jar.Accrual"/>.
    /// <paramref name="currentBalance"/> is used by <see cref="AccrualMethod.TargetByDate"/>;
    /// <paramref name="monthlyPool"/> and <paramref name="poolTargetTotal"/> by
    /// <see cref="AccrualMethod.ProportionalPool"/>.
    /// </summary>
    public static decimal RequiredMonthlyContribution(
        Jar jar,
        DateOnly asOf,
        decimal currentBalance = 0m,
        decimal monthlyPool = 0m,
        decimal poolTargetTotal = 0m)
        => jar.Accrual switch
        {
            AccrualMethod.StraightLine => StraightLine(jar),
            AccrualMethod.TargetByDate => TargetByDate(jar, asOf, currentBalance),
            AccrualMethod.ProportionalPool => ProportionalContribution(jar.TargetAmount, poolTargetTotal, monthlyPool),
            AccrualMethod.DailyRate => DailyRateForMonth(jar.TargetAmount, asOf),
            _ => 0m,
        };

    /// <summary>Target ÷ cover-period months (÷ 12 when no cover window is set).</summary>
    public static decimal StraightLine(Jar jar)
    {
        var months = CoverMonths(jar) ?? 12;
        if (months <= 0)
        {
            months = 12;
        }

        return Round2(jar.TargetAmount / months);
    }

    /// <summary>
    /// (Target − balance) ÷ whole months until the (recurrence-adjusted) target date,
    /// floored at one month. Returns 0 once the jar is fully funded. With no target
    /// date, falls back to ÷ 12.
    /// </summary>
    public static decimal TargetByDate(Jar jar, DateOnly asOf, decimal currentBalance)
    {
        var remaining = jar.TargetAmount - currentBalance;
        if (remaining <= 0m)
        {
            return 0m;
        }

        var months = EffectiveTargetDate(jar, asOf) is { } due ? MonthsBetween(asOf, due) : 12;
        if (months < 1)
        {
            months = 1;
        }

        return Round2(remaining / months);
    }

    /// <summary>
    /// The jar's target date with recurrence applied: a <see cref="JarKind.Recurring"/>
    /// jar whose date has passed re-arms to the next cycle on or after
    /// <paramref name="asOf"/> — a missed cycle simply spreads over the next one. This
    /// is a pure view over the stored <see cref="Jar.TargetDate"/> (the anchor), never
    /// persisted: each cycle is jumped from the anchor, so the day-of-month is preserved
    /// (a 31st-of-the-month bill never drifts to the 28th the way compounding rolls do).
    /// Goal dates never roll: a past-due Goal stays past-due and reads as Behind.
    /// </summary>
    public static DateOnly? EffectiveTargetDate(Jar jar, DateOnly asOf)
    {
        if (jar.TargetDate is not { } anchor)
        {
            return null;
        }

        if (jar.Kind != JarKind.Recurring || jar.RecurMonths is not { } step || step < 1 || anchor >= asOf)
        {
            return anchor;
        }

        // Closed-form: land near the boundary in one jump from the anchor, then nudge
        // the ≤1 cycle the whole-month estimate can be short (it ignores day-of-month).
        var cycles = MonthsBetween(anchor, asOf) / step;
        var next = anchor.AddMonths(cycles * step);
        while (next < asOf)
        {
            next = anchor.AddMonths(++cycles * step);
        }

        return next;
    }

    /// <summary>(jarTarget ÷ Σ pooled targets) × the fixed monthly pool. Returns 0 if the pool total is non-positive.</summary>
    public static decimal ProportionalContribution(decimal jarTarget, decimal poolTargetTotal, decimal monthlyPool)
    {
        if (poolTargetTotal <= 0m)
        {
            return 0m;
        }

        return Round2(jarTarget / poolTargetTotal * monthlyPool);
    }

    /// <summary>The daily accrual rate applied across the given month's day-count.</summary>
    public static decimal DailyRateForMonth(decimal target, DateOnly month)
        => Round2(target / 365m * DateTime.DaysInMonth(month.Year, month.Month));

    /// <summary>
    /// Progress accrued between two dates at the daily rate (Target ÷ 365 × days).
    /// Mirrors the spreadsheet's opening-balance estimate (Yearly Expenses col J).
    /// </summary>
    public static decimal AccruedByDailyRate(decimal target, DateOnly from, DateOnly to)
    {
        var days = to.DayNumber - from.DayNumber;
        if (days <= 0)
        {
            return 0m;
        }

        return Round2(target / 365m * days);
    }

    /// <summary>Whole calendar months from <paramref name="from"/> to <paramref name="to"/> (can be negative).</summary>
    private static int MonthsBetween(DateOnly from, DateOnly to)
        => ((to.Year * 12) + to.Month) - ((from.Year * 12) + from.Month);

    private static int? CoverMonths(Jar jar)
    {
        if (jar.CoverStart is { } start && jar.CoverEnd is { } end)
        {
            var months = MonthsBetween(start, end);
            return months > 0 ? months : null;
        }

        return null;
    }
}
