using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// A jar with its read-time-derived figures: the actual balance, this month's plan against
/// what has actually been contributed (rule 14), the dates that frame its schedule and a
/// status. Enum fields are serialised as their numeric value, mirroring <see cref="AccountType"/>.
/// </summary>
public class JarDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public JarKind Kind { get; set; }
    public decimal TargetAmount { get; set; }

    /// <summary>The stored deadline (anchor) — never the rolled date, so an edit round-trips faithfully. See <see cref="Deadline"/>.</summary>
    public DateOnly? TargetDate { get; set; }

    public AccrualMethod Accrual { get; set; }

    /// <summary>The fixed amount planned each month under a fixed monthly plan; null for a deadline plan.</summary>
    public decimal? MonthlyContribution { get; set; }

    /// <summary>Rule 36: whether the deadline month itself plans a contribution.</summary>
    public bool IncludeDeadlineMonth { get; set; }

    /// <summary>A Recurring jar's cycle length in months (its date rolls forward by this); null for Goals.</summary>
    public int? RecurMonths { get; set; }

    /// <summary>The account holding this jar's money (rule 2); always set.</summary>
    public Guid FundingAccountId { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>
    /// The jar's actual balance in its account as of <see cref="BalanceAsOf"/>: the allocations posted
    /// against it, never planned contributions (rule 1). Null when the account's balance is
    /// unavailable (rule 67), never zero.
    /// </summary>
    public decimal? CurrentBalance { get; set; }

    public DateOnly BalanceAsOf { get; set; }

    /// <summary>
    /// This month's planned contribution (rule 14): the month's savings line when the month exists,
    /// otherwise what the schedule plans from the balance at the month start. It does not fall as
    /// contributions land. 0 when the balance is unavailable or nothing is planned.
    /// </summary>
    public decimal PlannedThisMonth { get; set; }

    /// <summary>How much the jar's balance has grown since the month began (rule 14); 0 when unavailable.</summary>
    public decimal ContributedThisMonth { get; set; }

    /// <summary>What is still to contribute this month: plan − contributed, floored at zero (rule 14).</summary>
    public decimal RemainingThisMonth { get; set; }

    /// <summary>The deadline being saved toward, with a Recurring jar's cycle applied; null for fixed monthly plans.</summary>
    public DateOnly? Deadline { get; set; }

    /// <summary>When planned funding completes — the last day of the final planned month (rule 36); null when funded or not a deadline plan.</summary>
    public DateOnly? FundingCompletesOn { get; set; }

    /// <summary>Fixed monthly plans with a target: the monthly contributions still needed (rule 58; an estimate, not a deadline).</summary>
    public int? EstimatedMonthsToTarget { get; set; }

    /// <summary>Unavailable | Overspent | Ongoing | Unscheduled | FullyFunded | Behind | OnTrack.</summary>
    public string Status { get; set; } = "OnTrack";
}

public static class JarMapping
{
    /// <summary>
    /// Maps the jar from its two balances — now and entering the month (both null when
    /// unavailable, rule 67) — and the month's stored savings-line plan when the month exists.
    /// </summary>
    public static JarDto ToDto(this Jar f, decimal? currentBalance, decimal? balanceAtMonthStart, decimal? storedPlanThisMonth, DateOnly asOf)
    {
        var balance = currentBalance ?? 0m;
        var remaining = f.TargetAmount > 0m ? Math.Max(0m, f.TargetAmount - balance) : 0m;
        // The schedule is planned from the balance entering the month (rule 13), so it holds
        // still while contributions land during the month (rule 14). An account that opened this
        // month had nothing before it began.
        var startBalance = currentBalance is null ? 0m : balanceAtMonthStart ?? 0m;
        var plan = JarSchedule.Plan(f, asOf, startBalance);
        var deadline = plan.Deadline ?? JarSchedule.EffectiveDeadline(f, asOf);

        string status;
        if (currentBalance is null)
        {
            status = "Unavailable";
        }
        else if (balance < 0m)
        {
            status = "Overspent";
        }
        else if (plan.IsOngoing)
        {
            status = "Ongoing";
        }
        else if (f.TargetAmount > 0m && remaining == 0m)
        {
            // Holding the target needs no plan, so funded wins over Unscheduled.
            status = "FullyFunded";
        }
        else if (!JarSchedule.HasSchedule(f))
        {
            status = "Unscheduled";
        }
        else if (deadline is { } due && due < asOf)
        {
            // A Goal past its deadline (a Recurring jar re-arms, so its deadline is never past).
            status = "Behind";
        }
        else
        {
            status = "OnTrack";
        }

        var planned = currentBalance is null ? 0m : storedPlanThisMonth ?? plan.First;
        var contributed = currentBalance is null ? 0m : Math.Max(0m, balance - startBalance);

        return new JarDto
        {
            Id = f.Id,
            Name = f.Name,
            Kind = f.Kind,
            TargetAmount = f.TargetAmount,
            TargetDate = f.TargetDate,
            Accrual = f.Accrual,
            MonthlyContribution = f.MonthlyContribution,
            IncludeDeadlineMonth = f.IncludeDeadlineMonth,
            RecurMonths = f.RecurMonths,
            FundingAccountId = f.FundingAccountId,
            IsArchived = f.IsArchived,
            CurrentBalance = currentBalance,
            BalanceAsOf = asOf,
            PlannedThisMonth = planned,
            ContributedThisMonth = contributed,
            RemainingThisMonth = Math.Max(0m, planned - contributed),
            Deadline = deadline,
            FundingCompletesOn = currentBalance is null ? null : plan.FundingCompletesOn,
            EstimatedMonthsToTarget = currentBalance is null ? null : plan.EstimatedMonths,
            Status = status,
        };
    }
}
