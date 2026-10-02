using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>One planned month of a jar's contribution schedule.</summary>
/// <param name="Skipped">Rule 60: the user skipped this month's contribution; it plans 0 and the remaining months carry the plan.</param>
/// <param name="ByHand">O3b: the amount the user typed on this month's line while it was still a later month, kept by every replant; the other months carry the rest.</param>
public readonly record struct JarPlannedMonth(int Year, int Month, decimal Planned, bool Skipped = false, bool ByHand = false)
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
/// <param name="Deadline">The deadline the plan works toward (a Recurring jar's open cycle). Deadline plans only.</param>
/// <param name="FundingCompletesOn">The last day of the final planned month — when planned funding is complete (rule 36 distinguishes it from the deadline). Deadline plans with something left to save only.</param>
/// <param name="EstimatedMonths">Fixed monthly plans with a target: how many monthly contributions are still needed (rule 58, an estimate, never a deadline).</param>
/// <param name="IsOngoing">A fixed monthly plan with no target (rule 16).</param>
/// <param name="Unplanned">Deadline plans: the part of <paramref name="Remaining"/> no listed month carries because every eligible month before the deadline was skipped (rule 60/61); 0 otherwise.</param>
public sealed record JarPlan(
    IReadOnlyList<JarPlannedMonth> Months,
    decimal Remaining,
    DateOnly? Deadline,
    DateOnly? FundingCompletesOn,
    int? EstimatedMonths,
    bool IsOngoing,
    decimal Unplanned = 0m)
{
    /// <summary>
    /// O3b: the hand-typed months after the planned ones (past the funding-completion month, or
    /// after the target is reached), which a replant keeps as typed. Not in <see cref="Months"/>
    /// or <see cref="Total"/>: they are not part of the schedule, only left alone by it.
    /// </summary>
    public IReadOnlyList<JarPlannedMonth> ByHandLater { get; init; } = Array.Empty<JarPlannedMonth>();

    public static readonly JarPlan Empty = new(Array.Empty<JarPlannedMonth>(), 0m, null, null, null, false);

    /// <summary>What the first planned month (the month planned from) contributes; 0 when nothing is planned.</summary>
    public decimal First => Months.Count > 0 ? Months[0].Planned : 0m;

    public decimal Total => Months.Sum(m => m.Planned);
}

/// <summary>
/// What the planner is told about the months it plans over, beyond the jar's definition and the
/// balance it starts from.
/// </summary>
/// <param name="SkippedMonths">First days of the months whose contribution the user skipped (rule 60): each plans 0 and the other months carry the plan (rule 61).</param>
/// <param name="BalanceNow">
/// The jar's balance today, when it is above the planning balance (money arrived this month):
/// the first month is then assumed to end at <c>max(now, balance + planned)</c>, so a later
/// month is projected from what the jar will really hold (HANDOVER P37) while this month's own
/// plan never shrinks (rule 14). Null assumes the plan is simply kept.
/// </param>
/// <param name="ListThrough">Ongoing plans (rule 16): list every month up to this one instead of the single representative month, so each existing month can take its figure.</param>
/// <param name="ByHandMonths">
/// O3b: first days of the months whose line carries an amount the user typed by hand, with
/// that amount. Each plans exactly it and the other months carry the rest, as around a skipped
/// month (rule 61); a skip wins over it.
/// </param>
public sealed record JarPlanOptions(
    IReadOnlySet<DateOnly>? SkippedMonths = null,
    decimal? BalanceNow = null,
    DateOnly? ListThrough = null,
    IReadOnlyDictionary<DateOnly, decimal>? ByHandMonths = null)
{
    public static readonly JarPlanOptions None = new();

    public bool IsSkipped(DateOnly month) => SkippedMonths is not null && SkippedMonths.Contains(new DateOnly(month.Year, month.Month, 1));

    /// <summary>The amount typed by hand on <paramref name="month"/>'s line (O3b); null when it has none or is skipped.</summary>
    public decimal? ByHand(DateOnly month) =>
        !IsSkipped(month) && ByHandMonths is not null && ByHandMonths.TryGetValue(new DateOnly(month.Year, month.Month, 1), out var amount)
            ? amount
            : null;

    /// <summary>What the hand-typed months after <paramref name="after"/> and up to <paramref name="through"/> carry.</summary>
    public decimal ByHandBetween(DateOnly after, DateOnly through) =>
        ByHandMonths is null ? 0m : ByHandMonths.Where(m => m.Key > after && m.Key <= through && !IsSkipped(m.Key)).Sum(m => m.Value);
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
/// Skipped months (rule 60, W04) plan 0 and the remaining eligible months carry the plan, exactly
/// as rule 61's example: 300 due 1 December with September skipped plans 150 in October and 150
/// in November. An archived or completed jar plans nothing (rules 27, 55).
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

    /// <summary>
    /// Whether the jar still plans contributions at all: an archived jar's plans were cancelled
    /// (rule 27) and a completed Goal never restarts one (rule 55). Its definition may still have
    /// a schedule (<see cref="HasSchedule"/>), which is what an edit or a restore would plant.
    /// </summary>
    public static bool IsPlanning(Jar jar) => !jar.IsArchived && !jar.IsCompleted;

    /// <summary>Rule 55 read on a date: a Goal is completed from the day the user marked it, so on an earlier date it was still live (W05, a past month keeps the status it had).</summary>
    public static bool IsCompletedOn(Jar jar, DateOnly asOf) => jar.CompletedOn is { } completedOn && completedOn <= asOf;

    /// <summary>Rules 26–27 read on a date: a jar is archived from the day it was put away, so on an earlier date it was still live (W05). An archive with no recorded date counts on every date.</summary>
    public static bool IsArchivedOn(Jar jar, DateOnly asOf) => jar.IsArchived && (jar.ArchivedOn is not { } archivedOn || archivedOn <= asOf);

    /// <summary><see cref="IsPlanning(Jar)"/> as it stood on <paramref name="asOf"/>: an archive or a completion dated after it had not happened yet.</summary>
    public static bool IsPlanning(Jar jar, DateOnly asOf) => !IsArchivedOn(jar, asOf) && !IsCompletedOn(jar, asOf);

    /// <summary>An ongoing jar: a fixed monthly amount with no target (rule 16).</summary>
    public static bool IsOngoing(Jar jar) =>
        jar.Accrual == AccrualMethod.FixedMonthly && jar.MonthlyContribution is > 0m && jar.TargetAmount <= 0m;

    /// <summary>
    /// The deadline the jar is saving toward: a Recurring jar's open cycle
    /// (<see cref="Jar.CycleDeadline"/>, falling back to the anchor for a jar never settled),
    /// a Goal's date. Never rolls on its own (W03): a Recurring deadline that has passed is the
    /// persistent <b>Deadline missed</b> state until the cycle is closed — automatically when
    /// the target was held in time (rule 21), or by the user marking it paid (rule 83) or
    /// dismissing it (rule 20) — which advances the jar to <see cref="NextCycleDeadline"/>.
    /// </summary>
    public static DateOnly? CurrentDeadline(Jar jar) =>
        jar.Kind == JarKind.Recurring ? jar.CycleDeadline ?? jar.TargetDate : jar.TargetDate;

    /// <summary>
    /// The cycle after <paramref name="after"/>: the first deadline stepped whole cycles from
    /// the anchor <see cref="Jar.TargetDate"/> that falls after it. Stepping from the anchor keeps
    /// the intended day-of-month, so a shorter month clamps only that occurrence (rule 62:
    /// 31 January → 28 February → 31 March). Null for a jar with no date.
    /// </summary>
    public static DateOnly? NextCycleDeadline(Jar jar, DateOnly after)
    {
        if (jar.TargetDate is not { } anchor)
        {
            return null;
        }

        var step = jar.RecurMonths is > 0 ? jar.RecurMonths.Value : 12;
        // Closed-form: land near the boundary in one jump from the anchor, then nudge
        // the ≤1 cycle the whole-month estimate can be short (it ignores day-of-month).
        var cycles = Math.Max(0, MonthsBetween(anchor, after) / step);
        var next = anchor.AddMonths(cycles * step);
        while (next <= after)
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
    /// changes the month's plan — rule 14). <paramref name="options"/> carries the skipped months
    /// (rule 60), today's balance for the projection of later months and, for an ongoing jar,
    /// how many months to list.
    /// </summary>
    public static JarPlan Plan(Jar jar, DateOnly asOf, decimal balance, JarPlanOptions? options = null)
    {
        if (!HasSchedule(jar) || !IsPlanning(jar, asOf))
        {
            return JarPlan.Empty with { Remaining = jar.TargetAmount > 0m ? Math.Max(0m, jar.TargetAmount - balance) : 0m };
        }

        var from = new DateOnly(asOf.Year, asOf.Month, 1);
        options ??= JarPlanOptions.None;
        var plan = jar.Accrual == AccrualMethod.TargetByDate
            ? PlanByDeadline(jar, from, balance, options)
            : PlanFixedMonthly(jar, from, balance, options);
        if (options.ByHandMonths is not { Count: > 0 } byHand)
        {
            return plan;
        }
        // O3b: a hand-typed month the schedule doesn't reach is still left as typed; say so.
        var listed = plan.Months.Select(m => m.FirstDay).ToHashSet();
        return plan with
        {
            ByHandLater = byHand.Keys
                .Where(m => m >= from && !listed.Contains(m) && !options.IsSkipped(m))
                .OrderBy(m => m)
                .Select(m => new JarPlannedMonth(m.Year, m.Month, byHand[m], ByHand: true))
                .ToList(),
        };
    }

    /// <summary>
    /// What <paramref name="month"/> plans, given the balance entering it and the months the user
    /// skipped (rule 60, so a skipped later month never shrinks this one's share); 0 when nothing
    /// is planned.
    /// </summary>
    public static decimal PlannedFor(Jar jar, DateOnly month, decimal balance, JarPlanOptions? options = null) =>
        Plan(jar, month, balance, options).First;

    private static JarPlan PlanByDeadline(Jar jar, DateOnly from, decimal balance, JarPlanOptions options)
    {
        var deadline = CurrentDeadline(jar)!.Value;
        var remaining = Math.Max(0m, jar.TargetAmount - balance);
        if (remaining == 0m)
        {
            return new JarPlan(Array.Empty<JarPlannedMonth>(), 0m, deadline, null, null, false);
        }

        // Months from the planning month to the completion month, inclusive. A deadline that is
        // already this month, or has passed (a Goal past its date, or a Recurring cycle in its
        // Deadline-missed state), leaves no spread: the whole remainder is due now — the
        // recalculation of rule 13 with no months left, and the overdue amount stays visible.
        var end = FundingCompletionMonth(jar, deadline);
        if (end < from)
        {
            end = from;
        }

        // Rule 35 over the months that are not skipped (rule 60): equal whole-cent amounts with
        // the remainder in the last of them, so the plan still sums exactly. When the first
        // month is projected to end above its plan (money arrived this month, P37), the split
        // for the months after it is recomputed from that balance.
        // A month whose amount was typed by hand (O3b) plans exactly that, and the months that
        // are neither skipped nor typed share what the typed ones leave.
        var months = new List<JarPlannedMonth>();
        var eligible = 0;
        for (var m = from; m <= end; m = m.AddMonths(1))
        {
            if (!options.IsSkipped(m) && options.ByHand(m) is null)
            {
                eligible++;
            }
        }

        var projected = balance;
        var split = SplitExactly(Math.Max(0m, jar.TargetAmount - projected - options.ByHandBetween(from.AddDays(-1), end)), eligible);
        var k = 0;
        for (var m = from; m <= end; m = m.AddMonths(1))
        {
            var skipped = options.IsSkipped(m);
            var byHand = options.ByHand(m);
            var planned = skipped ? 0m : byHand ?? split[k++];
            months.Add(new JarPlannedMonth(m.Year, m.Month, planned, skipped, byHand is not null));
            var next = projected + planned;
            if (m == from && options.BalanceNow is { } now && now > next)
            {
                next = now;
                split = SplitExactly(Math.Max(0m, jar.TargetAmount - next - options.ByHandBetween(from, end)), eligible - k);
                k = 0;
            }
            projected = next;
        }

        var last = months.LastOrDefault(x => x.Planned > 0m);
        return new JarPlan(
            months, remaining, deadline,
            last.Planned > 0m ? last.LastDay : null,
            null, false,
            Unplanned: Math.Max(0m, jar.TargetAmount - projected));
    }

    private static JarPlan PlanFixedMonthly(Jar jar, DateOnly from, decimal balance, JarPlanOptions options)
    {
        var fixedAmount = jar.MonthlyContribution!.Value;
        if (jar.TargetAmount <= 0m)
        {
            // Ongoing: the same amount every month, no end (rule 16). One month stands for all,
            // unless the caller needs a run of months (existing budgets) or this one is skipped —
            // then the month it resumes in is listed too.
            var through = options.ListThrough is { } t && t > from ? new DateOnly(t.Year, t.Month, 1) : from;
            if (options.IsSkipped(through))
            {
                through = through.AddMonths(1);
            }
            var run = new List<JarPlannedMonth>();
            for (var m = from; m <= through; m = m.AddMonths(1))
            {
                var skipped = options.IsSkipped(m);
                var byHand = options.ByHand(m);
                run.Add(new JarPlannedMonth(m.Year, m.Month, skipped ? 0m : byHand ?? fixedAmount, skipped, byHand is not null));
            }
            return new JarPlan(run, 0m, null, null, null, true);
        }

        var remaining = Math.Max(0m, jar.TargetAmount - balance);
        if (remaining == 0m)
        {
            return new JarPlan(Array.Empty<JarPlannedMonth>(), 0m, null, null, 0, false);
        }

        // Rule 18: full amounts, then the remainder; rule 58: how many contributions that takes.
        // A skipped month (rule 60) plans 0 and pushes the estimate out by one month. Money that
        // arrived this month (P37) is counted whether or not this month is skipped, so a skipped
        // first month never makes the later ones ask for what the jar already holds.
        var months = new List<JarPlannedMonth>();
        var projected = balance;
        var contributions = 0;
        for (var m = from; months.Count < MaxListedMonths && projected < jar.TargetAmount; m = m.AddMonths(1))
        {
            var skipped = options.IsSkipped(m);
            var byHand = options.ByHand(m);
            var planned = skipped ? 0m : byHand ?? Math.Min(fixedAmount, jar.TargetAmount - projected);
            months.Add(new JarPlannedMonth(m.Year, m.Month, planned, skipped, byHand is not null));
            if (!skipped)
            {
                contributions++;
            }
            var next = projected + planned;
            if (m == from && options.BalanceNow is { } now && now > next)
            {
                next = now;
            }
            projected = next;
        }
        var needed = projected < jar.TargetAmount
            ? contributions + (int)Math.Ceiling((jar.TargetAmount - projected) / fixedAmount)
            : contributions;

        return new JarPlan(months, remaining, null, null, needed, false);
    }

    /// <summary>
    /// Rule 35: <paramref name="count"/> equal whole-cent amounts with the rounding remainder in
    /// the final one, so they sum exactly to <paramref name="remaining"/> and none is ever
    /// negative. 100 over three months plans 33.33, 33.33, 33.34. Empty when there is no month.
    /// </summary>
    private static decimal[] SplitExactly(decimal remaining, int count)
    {
        if (count <= 0)
        {
            return Array.Empty<decimal>();
        }
        var each = Math.Floor(remaining / count * 100m) / 100m;
        var amounts = new decimal[count];
        for (var i = 0; i < count; i++)
        {
            amounts[i] = i == count - 1 ? remaining - (each * (count - 1)) : each;
        }
        return amounts;
    }

    /// <summary>Whole calendar months from <paramref name="from"/> to <paramref name="to"/> (can be negative).</summary>
    public static int MonthsBetween(DateOnly from, DateOnly to)
        => ((to.Year * 12) + to.Month) - ((from.Year * 12) + from.Month);
}
