using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>One planned month of a jar's contribution schedule.</summary>
public readonly record struct JarPlannedMonth(int Year, int Month, decimal Planned)
{
    public DateOnly FirstDay => new(Year, Month, 1);
    public DateOnly LastDay => new(Year, Month, DateTime.DaysInMonth(Year, Month));
}

/// <summary>
/// A jar's contribution schedule from a given month, planned from the balance it holds
/// entering that month. Empty when nothing is (or can be) planned: the target is already
/// held, or the jar has no usable plan (rule 17).
/// </summary>
/// <param name="Months">The planned months in order. One month for an ongoing jar (every month plans the same fixed amount).</param>
/// <param name="Remaining">Target − balance, floored at zero; 0 for an ongoing jar.</param>
/// <param name="Deadline">The deadline the plan works toward, with a Recurring jar's cycle applied. Deadline plans only.</param>
/// <param name="FundingCompletesOn">The last day of the final planned month — when planned funding is complete (rule 36 distinguishes it from the deadline). Deadline plans with something left to save only.</param>
/// <param name="EstimatedMonths">Fixed monthly plans with a target: how many monthly contributions are still needed (rule 58, an estimate, never a deadline).</param>
/// <param name="IsOngoing">A fixed monthly plan with no target (rule 16).</param>
public sealed record JarPlan(
    IReadOnlyList<JarPlannedMonth> Months,
    decimal Remaining,
    DateOnly? Deadline,
    DateOnly? FundingCompletesOn,
    int? EstimatedMonths,
    bool IsOngoing)
{
    public static readonly JarPlan Empty = new(Array.Empty<JarPlannedMonth>(), 0m, null, null, null, false);

    /// <summary>What the first planned month (the month planned from) contributes; 0 when nothing is planned.</summary>
    public decimal First => Months.Count > 0 ? Months[0].Planned : 0m;

    public decimal Total => Months.Sum(m => m.Planned);
}

/// <summary>
/// Pure (no I/O) planner for a <see cref="Jar"/>'s monthly contributions — the one derivation
/// behind the form's preview, month seeding, the Jars page and every replanting, so they can
/// never disagree (W02: "exact preview/server agreement").
///
/// Deadline plans (rules 12–13, 35–36): the remaining target is split equally, in whole cents,
/// over the months from the planning month up to the funding-completion month, and the rounding
/// remainder goes into the final month so the plan sums exactly. Funding completes the month
/// before the deadline unless the user includes the deadline month (rule 36). Recalculating from
/// the actual balance at each month start keeps the exact-total property (rule 13).
///
/// Fixed monthly plans (rules 16–18, 58): the chosen amount every month; with a target, the
/// final month is capped at what remains and nothing is planned once the target is held.
///
/// Dates are plain calendar dates (HANDOVER O2, 27 September 2026): no timezone applies, the
/// planning month counts as a contribution month until it ends, and the deadline day itself is
/// never a contribution day.
/// </summary>
public static class JarSchedule
{
    /// <summary>A fixed monthly plan toward a target lists at most this many months (ten years).</summary>
    public const int MaxListedMonths = 120;

    /// <summary>
    /// Whether the jar's definition yields a plan at all: a deadline plan needs a target and a
    /// deadline, a fixed monthly plan needs its amount (rule 17). A jar without one plans nothing.
    /// </summary>
    public static bool HasSchedule(Jar jar) => jar.Accrual switch
    {
        AccrualMethod.TargetByDate => jar.TargetAmount > 0m && jar.TargetDate is not null,
        AccrualMethod.FixedMonthly => jar.MonthlyContribution is > 0m,
        _ => false,
    };

    /// <summary>An ongoing jar: a fixed monthly amount with no target (rule 16).</summary>
    public static bool IsOngoing(Jar jar) =>
        jar.Accrual == AccrualMethod.FixedMonthly && jar.MonthlyContribution is > 0m && jar.TargetAmount <= 0m;

    /// <summary>
    /// The jar's deadline with recurrence applied: a <see cref="JarKind.Recurring"/> jar whose
    /// date has passed re-arms to the next cycle on or after <paramref name="asOf"/>. This is a
    /// pure view over the stored <see cref="Jar.TargetDate"/> (the anchor), never persisted: each
    /// cycle is jumped from the anchor, so the intended day-of-month is kept and a shorter month
    /// clamps only that occurrence (rule 62). Goal dates never roll: a past-due Goal stays past-due.
    /// The Deadline-missed lifecycle (rules 20–24, W03) will replace the silent roll.
    /// </summary>
    public static DateOnly? EffectiveDeadline(Jar jar, DateOnly asOf)
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

    /// <summary>
    /// The last month that plans a contribution toward <paramref name="deadline"/>: the month
    /// before it (the money must be there before the deadline begins, rule 12), or the deadline
    /// month itself when the deadline falls after the 1st and the jar opts in (rule 36).
    /// </summary>
    public static DateOnly FundingCompletionMonth(Jar jar, DateOnly deadline)
    {
        var month = deadline.Day > 1 && jar.IncludeDeadlineMonth ? deadline : deadline.AddMonths(-1);
        return new DateOnly(month.Year, month.Month, 1);
    }

    /// <summary>
    /// The plan from <paramref name="asOf"/>'s month onward, given the balance the jar holds
    /// entering that month (rule 13: the month start, so a contribution during the month never
    /// changes the month's plan — rule 14).
    /// </summary>
    public static JarPlan Plan(Jar jar, DateOnly asOf, decimal balance)
    {
        if (!HasSchedule(jar))
        {
            return JarPlan.Empty with { Remaining = Math.Max(0m, jar.TargetAmount - balance) };
        }

        var from = new DateOnly(asOf.Year, asOf.Month, 1);
        return jar.Accrual == AccrualMethod.TargetByDate
            ? PlanByDeadline(jar, asOf, from, balance)
            : PlanFixedMonthly(jar, from, balance);
    }

    /// <summary>What <paramref name="month"/> plans, given the balance entering it; 0 when nothing is planned.</summary>
    public static decimal PlannedFor(Jar jar, DateOnly month, decimal balance) => Plan(jar, month, balance).First;

    private static JarPlan PlanByDeadline(Jar jar, DateOnly asOf, DateOnly from, decimal balance)
    {
        var deadline = EffectiveDeadline(jar, asOf)!.Value;
        var remaining = Math.Max(0m, jar.TargetAmount - balance);
        if (remaining == 0m)
        {
            return new JarPlan(Array.Empty<JarPlannedMonth>(), 0m, deadline, null, null, false);
        }

        // Months from the planning month to the completion month, inclusive. A deadline that is
        // already this month (or has passed, for a Goal) leaves no spread: the whole remainder is
        // due now — the recalculation of rule 13 with no months left.
        var count = MonthsBetween(from, FundingCompletionMonth(jar, deadline)) + 1;
        if (count < 1)
        {
            count = 1;
        }

        var months = SplitExactly(remaining, count, from);
        return new JarPlan(months, remaining, deadline, months[^1].LastDay, null, false);
    }

    private static JarPlan PlanFixedMonthly(Jar jar, DateOnly from, decimal balance)
    {
        var fixedAmount = jar.MonthlyContribution!.Value;
        if (jar.TargetAmount <= 0m)
        {
            // Ongoing: the same amount every month, no end (rule 16). One month stands for all.
            return new JarPlan(new[] { new JarPlannedMonth(from.Year, from.Month, fixedAmount) }, 0m, null, null, null, true);
        }

        var remaining = Math.Max(0m, jar.TargetAmount - balance);
        if (remaining == 0m)
        {
            return new JarPlan(Array.Empty<JarPlannedMonth>(), 0m, null, null, 0, false);
        }

        // Rule 18: full amounts, then the remainder; rule 58: how many months that takes.
        var needed = (int)Math.Ceiling(remaining / fixedAmount);
        var listed = Math.Min(needed, MaxListedMonths);
        var months = new JarPlannedMonth[listed];
        var left = remaining;
        for (var i = 0; i < listed; i++)
        {
            var month = from.AddMonths(i);
            var planned = i == needed - 1 ? left : fixedAmount;
            months[i] = new JarPlannedMonth(month.Year, month.Month, planned);
            left -= planned;
        }

        return new JarPlan(months, remaining, null, null, needed, false);
    }

    /// <summary>
    /// Rule 35: <paramref name="count"/> equal whole-cent amounts with the rounding remainder in
    /// the final month, so the months sum exactly to <paramref name="remaining"/> and no month is
    /// ever negative. 100 over three months plans 33.33, 33.33, 33.34.
    /// </summary>
    private static JarPlannedMonth[] SplitExactly(decimal remaining, int count, DateOnly from)
    {
        var each = Math.Floor(remaining / count * 100m) / 100m;
        var months = new JarPlannedMonth[count];
        for (var i = 0; i < count; i++)
        {
            var month = from.AddMonths(i);
            var planned = i == count - 1 ? remaining - (each * (count - 1)) : each;
            months[i] = new JarPlannedMonth(month.Year, month.Month, planned);
        }

        return months;
    }

    /// <summary>Whole calendar months from <paramref name="from"/> to <paramref name="to"/> (can be negative).</summary>
    public static int MonthsBetween(DateOnly from, DateOnly to)
        => ((to.Year * 12) + to.Month) - ((from.Year * 12) + from.Month);
}
