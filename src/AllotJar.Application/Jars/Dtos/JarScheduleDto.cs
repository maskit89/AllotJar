using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// A jar definition's contribution schedule from the current month — what the form previews
/// and exactly what saving it would plant on the Savings lines (W02: preview and saved plans
/// agree because both come from the same planner).
/// </summary>
public class JarScheduleDto
{
    public AccrualMethod Accrual { get; set; }

    /// <summary>A fixed monthly plan with no target (rule 16): the one month listed stands for every month.</summary>
    public bool IsOngoing { get; set; }

    /// <summary>Whether the definition yields a plan at all (rule 17); when false nothing is planned.</summary>
    public bool HasSchedule { get; set; }

    /// <summary>The balance the plan starts from: the jar's actual balance entering this month plus any money being set aside now.</summary>
    public decimal Balance { get; set; }

    /// <summary>Target − balance, floored at zero.</summary>
    public decimal Remaining { get; set; }

    /// <summary>The planned months in order; empty when nothing is left to save.</summary>
    public List<JarScheduleMonthDto> Months { get; set; } = new();

    /// <summary>Sum of the planned months (equals <see cref="Remaining"/> for a deadline plan, rule 35).</summary>
    public decimal Total { get; set; }

    /// <summary>The deadline saved toward, with a Recurring jar's cycle applied; deadline plans only.</summary>
    public DateOnly? Deadline { get; set; }

    /// <summary>The last day of the final planned month (rule 36); deadline plans with something to save only.</summary>
    public DateOnly? FundingCompletesOn { get; set; }

    /// <summary>Fixed monthly plans with a target: monthly contributions still needed (rule 58, an estimate).</summary>
    public int? EstimatedMonths { get; set; }

    /// <summary>
    /// Rule 60/61 (W04): for a deadline plan, the part of <see cref="Remaining"/> that no month before
    /// the deadline carries because every eligible month was skipped — the plan cannot fund the target
    /// in time and says so. 0 otherwise.
    /// </summary>
    public decimal Unplanned { get; set; }
}

public class JarScheduleMonthDto
{
    public int Year { get; set; }
    public int Month { get; set; }
    public decimal Planned { get; set; }

    /// <summary>Rule 60 (W04): the user skipped this month's contribution; it plans 0 and the other months carry the plan.</summary>
    public bool Skipped { get; set; }

    /// <summary>Whether a budget already exists for this month.</summary>
    public bool HasBudget { get; set; }

    /// <summary>
    /// Rule 59: for a month that has a budget, how far its planned total would exceed its income
    /// once this contribution replaces the jar's current line (0 when it fits); null when the
    /// month has no budget yet.
    /// </summary>
    public decimal? Shortfall { get; set; }
}
