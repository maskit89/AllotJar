using AllotJar.Application.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// A jar with its read-time-derived figures: the actual balance, this month's plan against
/// what has actually been contributed (rule 14), the dates that frame its schedule and a
/// status. Enum fields are serialised as their numeric value, mirroring <see cref="AccountType"/>.
/// For a month that is over, the definition fields (kind, target, dates and plan settings) are the
/// ones the jar had at that month's end, which its status was judged against (P49).
/// </summary>
public class JarDto
{
    public Guid Id { get; set; }

    /// <summary>The row version the edit form sends back with its save (D11); null where the store keeps none.</summary>
    public string? Version { get; set; }

    public string Name { get; set; } = string.Empty;
    public JarKind Kind { get; set; }

    /// <summary>The target the status was judged against: today's, or for a month that is over the one the jar had at its end (P49).</summary>
    public decimal TargetAmount { get; set; }

    /// <summary>The stored deadline (anchor) — never the rolled date, so an edit round-trips faithfully. See <see cref="Deadline"/>.</summary>
    public DateOnly? TargetDate { get; set; }

    public AccrualMethod Accrual { get; set; }

    /// <summary>The fixed amount planned each month under a fixed monthly plan; null for a deadline plan.</summary>
    public decimal? MonthlyContribution { get; set; }

    /// <summary>Rule 36: whether the deadline month itself plans a contribution.</summary>
    public bool IncludeDeadlineMonth { get; set; }

    /// <summary>The date is just a month (the 1st of it): shown as "Mar 2027", never "1 Mar 2027" (Jar.MonthOnly).</summary>
    public bool MonthOnly { get; set; }

    /// <summary>A Recurring jar's cycle length in months (its date rolls forward by this); null for Goals.</summary>
    public int? RecurMonths { get; set; }

    /// <summary>The account holding this jar's money (rule 2); always set.</summary>
    public Guid FundingAccountId { get; set; }
    public bool IsArchived { get; set; }

    /// <summary>Rule 55 (W04): when the user marked this Goal's purpose completed; null while it is live. A completed jar plans nothing and keeps what it holds until it is moved (rule 56).</summary>
    public DateOnly? CompletedOn { get; set; }

    /// <summary>
    /// Rule 84 (W04): true when the jar never held money — nothing allocated to it, nothing spent
    /// from it — so it may be permanently deleted (removing its planned lines). Every other jar can
    /// only be archived, keeping its history (rules 25–27).
    /// </summary>
    public bool CanDelete { get; set; }

    /// <summary>
    /// The jar's actual balance as of <see cref="BalanceAsOf"/>: the allocations posted against it
    /// in whichever account held it then (rule 80), never planned contributions (rule 1). Null when
    /// its current account has no opening date, or had not opened on that date and no other open
    /// account's ledger carries the jar (rule 67), never zero.
    /// </summary>
    public decimal? CurrentBalance { get; set; }

    public DateOnly BalanceAsOf { get; set; }

    /// <summary>
    /// This month's planned contribution (rule 14): the month's savings line when the month has
    /// one; for a month that is over and has none, 0 (no plan is invented after the fact, rule 46);
    /// otherwise what the schedule plans from the balance at the month start (or today's, when
    /// money left the jar this month). It does not fall as contributions land. 0 when the balance
    /// is unavailable or nothing is planned.
    /// </summary>
    public decimal PlannedThisMonth { get; set; }

    /// <summary>How much the jar's balance has grown since the month began (rule 14); 0 when unavailable.</summary>
    public decimal ContributedThisMonth { get; set; }

    /// <summary>What is still to contribute this month: plan − contributed, floored at zero (rule 14).</summary>
    public decimal RemainingThisMonth { get; set; }

    /// <summary>Rule 60 (W04): the user skipped this month's contribution; the month's line stands at 0 and the remaining months carry the plan (rule 61).</summary>
    public bool SkippedThisMonth { get; set; }

    /// <summary>The deadline being saved toward — a Recurring jar's open cycle (W03); null for fixed monthly plans.</summary>
    public DateOnly? Deadline { get; set; }

    /// <summary>
    /// Rule 20: a Recurring jar whose open cycle's deadline has arrived short of its target is in
    /// the persistent <b>Deadline missed</b> state until the user marks the cycle paid or
    /// dismisses it; this is target − balance, floored at zero (rule 57: 0 once funded late).
    /// Null when the jar is not in that state.
    /// </summary>
    public decimal? Shortfall { get; set; }

    /// <summary>The jar's most recently closed cycle (W03), so the card can say how the last one ended; null when none has closed yet.</summary>
    public JarCycleDto? LastCycle { get; set; }

    /// <summary>When planned funding completes — the last day of the final planned month (rule 36); null when funded or not a deadline plan.</summary>
    public DateOnly? FundingCompletesOn { get; set; }

    /// <summary>Fixed monthly plans with a target: the monthly contributions still needed (rule 58; an estimate, not a deadline).</summary>
    public int? EstimatedMonthsToTarget { get; set; }

    /// <summary>Unavailable | Completed | DeadlineMissed | FundedLate | Overspent | Ongoing | Unscheduled | FullyFunded | Behind | OnTrack.</summary>
    public string Status { get; set; } = "OnTrack";
}

/// <summary>A closed cycle of a Recurring jar (W03). Money never moved when it closed; the balance carried forward (rule 19).</summary>
public class JarCycleDto
{
    public Guid Id { get; set; }
    public DateOnly Deadline { get; set; }
    public decimal TargetAmount { get; set; }

    /// <summary>Paid | Funded | Missed | FundedLate — see <see cref="JarCycleOutcome"/> — or Waiting: unpaid, its deadline not yet come and nothing judged (D17).</summary>
    public string Outcome { get; set; } = string.Empty;

    /// <summary>The balance at the end of the day before the deadline; null when it was unavailable.</summary>
    public decimal? BalanceAtDeadline { get; set; }

    /// <summary>The payment chosen as fulfilling the cycle (rule 83); the id is null once that transaction is deleted, the date and amount stay.</summary>
    public Guid? PaymentTransactionId { get; set; }
    public string? PaymentPayee { get; set; }
    public DateOnly? PaidOn { get; set; }
    public decimal? PaidAmount { get; set; }

    /// <summary>A paid cycle whose payment landed before the deadline (rule 22).</summary>
    public bool PaidOnTime { get; set; }

    public DateOnly ClosedOn { get; set; }
}

public static class JarMapping
{
    /// <summary>
    /// Maps the jar from its two balances — as of <paramref name="asOf"/> and entering the month
    /// (both null when unavailable, rule 67) — and the month's stored savings-line plan when the
    /// month exists. <paramref name="month"/> is the budget month the figures belong to (W05, rule
    /// 48); it is the month of <paramref name="asOf"/> unless the month has not begun yet, when
    /// the balances are today's and the plan is the later month's own line.
    /// <paramref name="f"/> is the definition the month is judged against: the jar as it is today, or
    /// for a month that is over the jar as it was defined at its end, with the Recurring cycle open
    /// then (<see cref="JarHistory.DefinitionOn"/>, P49).
    /// <paramref name="contributedThisMonth"/> is what went into the jar in the month
    /// (<see cref="JarLedgerSource.ContributionsBetween"/>): rule 14's figure, which what left the
    /// jar never reduces. Left null, the figure is derived from the two balances — net of any
    /// money that left the jar in the month — for callers that hold only those.
    /// </summary>
    public static JarDto ToDto(this Jar f, decimal? currentBalance, decimal? balanceAtMonthStart, decimal? storedPlanThisMonth, DateOnly asOf,
        JarCycle? lastCycle = null, bool skippedThisMonth = false, bool canDelete = false, IReadOnlySet<DateOnly>? skippedMonths = null,
        DateOnly? month = null, decimal? contributedThisMonth = null, IReadOnlyDictionary<DateOnly, decimal>? byHandMonths = null)
    {
        var balance = currentBalance ?? 0m;
        var target = f.TargetAmount;
        var remaining = target > 0m ? Math.Max(0m, target - balance) : 0m;
        // The schedule is planned from the balance entering the month (rule 13), so it holds
        // still while contributions land during the month (rule 14) — unless money left the jar,
        // which counts at once (JarPlanner.PlanningBalance). An account that opened this month
        // had nothing before it began.
        var startBalance = currentBalance is null ? 0m : JarPlanner.PlanningBalance(balanceAtMonthStart, currentBalance);
        // The months the user skipped (rule 60) — this one and any later — shape the horizon the
        // card shows, exactly as they shape the plan the Savings lines carry (rule 61).
        var monthStart = month is { } m ? new DateOnly(m.Year, m.Month, 1) : new DateOnly(asOf.Year, asOf.Month, 1);
        var skipped = new HashSet<DateOnly>(skippedMonths ?? (IEnumerable<DateOnly>)Array.Empty<DateOnly>());
        if (skippedThisMonth)
        {
            skipped.Add(monthStart);
        }
        // A month that has not begun is planned from that month (its own share of what is left,
        // from today's balance), never from today's month.
        var planFrom = monthStart > asOf ? monthStart : asOf;
        // Today's balance rides along as the schedule preview passes it (rule 58): money that arrived this month
        // shortens the estimate on the card exactly as it does in the edit preview. The later months typed by
        // hand (O3b) carry their amount, as the Savings lines do.
        var plan = JarSchedule.Plan(f, planFrom, startBalance, new JarPlanOptions(skipped, currentBalance, ByHandMonths: byHandMonths));
        var deadline = plan.Deadline ?? JarSchedule.CurrentDeadline(f);
        // Rule 20: a Recurring cycle whose deadline has arrived is settled before this read
        // (JarCycles.SettleAsync rolls a funded one forward), so an open cycle at or before the
        // date is one that was short when the money had to be there. It stays that way — and
        // reads Funded late once the target is reached (rule 57) — until the user acts. A jar
        // archived since that date was still live on it (W05), so its month keeps that state.
        // A month given without a day is missed only once that month is over (it reads Behind
        // while the month runs, below).
        var missed = currentBalance is not null && f.Kind == JarKind.Recurring && !JarSchedule.IsArchivedOn(f, asOf)
                     && JarSchedule.HasSchedule(f) && deadline is { } due0 && JarSchedule.LateFrom(due0, f.MonthOnly) <= asOf;

        string status;
        if (currentBalance is null)
        {
            status = "Unavailable";
        }
        else if (JarSchedule.IsCompletedOn(f, asOf))
        {
            // Rule 55: done is done — a spent or empty balance never restarts a plan, and what
            // is left stays visible until the user moves it (rule 56). Completion is dated, so a
            // month before it reads the status the jar had then (W05, rule 48).
            status = "Completed";
        }
        else if (missed)
        {
            status = remaining == 0m ? "FundedLate" : "DeadlineMissed";
        }
        else if (balance < 0m)
        {
            status = "Overspent";
        }
        else if (plan.IsOngoing)
        {
            status = "Ongoing";
        }
        else if (target > 0m && remaining == 0m)
        {
            // Holding the target needs no plan, so funded wins over Unscheduled.
            status = "FullyFunded";
        }
        else if (!JarSchedule.HasSchedule(f))
        {
            status = "Unscheduled";
        }
        else if (deadline is { } due && (due < asOf || (due == asOf && JarSchedule.LateFrom(due, f.MonthOnly) != due)))
        {
            // A Goal past its deadline (a Recurring jar's is the Deadline-missed state above), or
            // a jar due in a month that has begun without the money in it: the warning while the
            // month runs, from its 1st.
            status = "Behind";
        }
        else
        {
            status = "OnTrack";
        }

        var planned = currentBalance is null ? 0m : storedPlanThisMonth ?? plan.First;
        // Rule 14: what went in this month, whatever left it since (a bill paid from the jar moves
        // its balance and its plan, never what was contributed).
        var contributed = currentBalance is null ? 0m : contributedThisMonth ?? Math.Max(0m, balance - startBalance);

        return new JarDto
        {
            Id = f.Id,
            Version = EditVersions.Of(f),
            Name = f.Name,
            Kind = f.Kind,
            TargetAmount = f.TargetAmount,
            TargetDate = f.TargetDate,
            Accrual = f.Accrual,
            MonthlyContribution = f.MonthlyContribution,
            IncludeDeadlineMonth = f.IncludeDeadlineMonth,
            MonthOnly = f.MonthOnly,
            RecurMonths = f.RecurMonths,
            FundingAccountId = f.FundingAccountId,
            IsArchived = f.IsArchived,
            CompletedOn = f.CompletedOn,
            CanDelete = canDelete,
            CurrentBalance = currentBalance,
            BalanceAsOf = asOf,
            PlannedThisMonth = planned,
            ContributedThisMonth = contributed,
            RemainingThisMonth = Math.Max(0m, planned - contributed),
            SkippedThisMonth = skippedThisMonth && currentBalance is not null,
            Deadline = deadline,
            FundingCompletesOn = currentBalance is null ? null : plan.FundingCompletesOn,
            EstimatedMonthsToTarget = currentBalance is null ? null : plan.EstimatedMonths,
            Status = status,
            Shortfall = missed ? remaining : null,
            LastCycle = lastCycle?.ToDto(),
        };
    }

    /// <summary>The outcome a cycle reads while it waits for its deadline to be judged (D17).</summary>
    public const string WaitingOutcome = "Waiting";

    public static JarCycleDto ToDto(this JarCycle c) => new()
    {
        Id = c.Id,
        Deadline = c.Deadline,
        TargetAmount = c.TargetAmount,
        // A cycle whose payment was removed before its deadline is judged only when the deadline
        // arrives (JarCycles.ReopenPaidByAsync): until then it reads as waiting, never as funded
        // on time (D17).
        Outcome = c is { Outcome: JarCycleOutcome.Funded, PaymentTransactionId: null, BalanceAtDeadline: null }
            ? WaitingOutcome
            : c.Outcome.ToString(),
        BalanceAtDeadline = c.BalanceAtDeadline,
        PaymentTransactionId = c.PaymentTransactionId,
        PaymentPayee = c.PaymentTransaction?.Payee,
        PaidOn = c.PaidOn,
        PaidAmount = c.PaidAmount,
        PaidOnTime = c.PaidOnTime,
        ClosedOn = c.ClosedOn,
    };
}
