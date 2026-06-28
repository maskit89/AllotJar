using ZeroBudget.Domain.Entities;
using ZeroBudget.Domain.Enums;

namespace ZeroBudget.Domain.Services;

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
    /// The amount to put into the fund this month, per its <see cref="Jar.Accrual"/>.
    /// <paramref name="currentBalance"/> is used by <see cref="AccrualMethod.TargetByDate"/>;
    /// <paramref name="monthlyPool"/> and <paramref name="poolTargetTotal"/> by
    /// <see cref="AccrualMethod.ProportionalPool"/>.
    /// </summary>
    public static decimal RequiredMonthlyContribution(
        Jar fund,
        DateOnly asOf,
        decimal currentBalance = 0m,
        decimal monthlyPool = 0m,
        decimal poolTargetTotal = 0m)
        => fund.Accrual switch
        {
            AccrualMethod.StraightLine => StraightLine(fund),
            AccrualMethod.TargetByDate => TargetByDate(fund, asOf, currentBalance),
            AccrualMethod.ProportionalPool => ProportionalContribution(fund.TargetAmount, poolTargetTotal, monthlyPool),
            AccrualMethod.DailyRate => DailyRateForMonth(fund.TargetAmount, asOf),
            _ => 0m,
        };

    /// <summary>Target ÷ cover-period months (÷ 12 when no cover window is set).</summary>
    public static decimal StraightLine(Jar fund)
    {
        var months = CoverMonths(fund) ?? 12;
        if (months <= 0)
        {
            months = 12;
        }

        return Round2(fund.TargetAmount / months);
    }

    /// <summary>
    /// (Target − balance) ÷ whole months until the target date, floored at one month.
    /// Returns 0 once the fund is fully funded. With no target date, falls back to ÷ 12.
    /// </summary>
    public static decimal TargetByDate(Jar fund, DateOnly asOf, decimal currentBalance)
    {
        var remaining = fund.TargetAmount - currentBalance;
        if (remaining <= 0m)
        {
            return 0m;
        }

        var months = fund.TargetDate is { } due ? MonthsBetween(asOf, due) : 12;
        if (months < 1)
        {
            months = 1;
        }

        return Round2(remaining / months);
    }

    /// <summary>(fundTarget ÷ Σ pooled targets) × the fixed monthly pool. Returns 0 if the pool total is non-positive.</summary>
    public static decimal ProportionalContribution(decimal fundTarget, decimal poolTargetTotal, decimal monthlyPool)
    {
        if (poolTargetTotal <= 0m)
        {
            return 0m;
        }

        return Round2(fundTarget / poolTargetTotal * monthlyPool);
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

    private static int? CoverMonths(Jar fund)
    {
        if (fund.CoverStart is { } start && fund.CoverEnd is { } end)
        {
            var months = MonthsBetween(start, end);
            return months > 0 ? months : null;
        }

        return null;
    }
}
