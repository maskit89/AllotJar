using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A sinking fund: a periodic or one-off expense target that is saved towards a
/// little each month and spent against over time (e.g. "Home Insurance €300/yr",
/// "Yearly Holiday €4000"). It owns the fund's <see cref="TargetAmount"/>, deadline
/// and the way its contributions are planned (<see cref="Accrual"/>); each month's
/// contribution to it is an ordinary <see cref="BudgetItem"/> in a
/// <see cref="CategoryKind.Savings"/> group whose <see cref="BudgetItem.SavingsId"/>
/// equals this fund's <see cref="BaseEntity.Id"/>, planned by
/// AllotJar.Domain.Services.JarSchedule.
///
/// The actual balance is NOT stored here — it is derived at read time from the
/// designated account's recorded money and the jar allocations posted against it
/// (see AllotJar.Domain.Services.ActualSavingsLedger and the Application JarLedgerReader).
/// Planned contributions never count as money (rule 1). This entity holds only the
/// jar's live definition; an edit that changes it is also dated as a <see cref="JarRevision"/>,
/// so a month that is over keeps the definition it had (P49).
/// </summary>
public class Jar : BaseEntity
{
    /// <summary>Identity user id that owns this fund (the household).</summary>
    public string OwnerId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public JarKind Kind { get; set; } = JarKind.Recurring;

    /// <summary>
    /// The amount to accumulate; 0 for an ongoing jar that saves a fixed amount with no
    /// target (rule 16). Mapped to decimal(18,4).
    /// </summary>
    public decimal TargetAmount { get; set; }

    /// <summary>
    /// The deadline the target must be ready by (rule 15): the money must be in the
    /// designated account before this date, so planned funding completes the month before
    /// unless <see cref="IncludeDeadlineMonth"/> opts in (rule 36). Required for
    /// <see cref="AccrualMethod.TargetByDate"/>; null for a fixed monthly plan.
    /// </summary>
    public DateOnly? TargetDate { get; set; }

    /// <summary>How the monthly contribution is planned (rules 16–17).</summary>
    public AccrualMethod Accrual { get; set; } = AccrualMethod.TargetByDate;

    /// <summary>
    /// The fixed amount planned each month under <see cref="AccrualMethod.FixedMonthly"/>
    /// (rules 16–18); null for a deadline plan, whose monthly amount is calculated.
    /// </summary>
    public decimal? MonthlyContribution { get; set; }

    /// <summary>
    /// Rule 36: for a deadline partway through a month, planned funding completes at the end of
    /// the previous month by default. True plans a contribution in the deadline month too — the
    /// user has accepted that the money must reach the account before the deadline day.
    /// Meaningless when the deadline falls on the 1st.
    /// </summary>
    public bool IncludeDeadlineMonth { get; set; }

    /// <summary>
    /// A Recurring jar's cycle length in months: each closed cycle advances
    /// <see cref="CycleDeadline"/> by this many months from the anchor <see cref="TargetDate"/>
    /// (see Services.JarSchedule.NextCycleDeadline). Null for
    /// <see cref="JarKind.Goal"/> jars, which end at their target instead of renewing —
    /// the create/update handlers keep it in lockstep with <see cref="Kind"/>.
    /// </summary>
    public int? RecurMonths { get; set; }

    /// <summary>
    /// A Recurring jar's open cycle: the concrete deadline it is saving toward right now (W03).
    /// Starts at <see cref="TargetDate"/> and advances one cycle at a time — automatically when
    /// the target was held as the deadline arrived (rule 21), or when the user marks the cycle
    /// paid (rule 83) or dismisses a missed deadline (rule 20); each closed cycle becomes a
    /// <see cref="JarCycle"/>. A deadline at or before today that was not met is the persistent
    /// <b>Deadline missed</b> state. Each cycle is stepped from the anchor <see cref="TargetDate"/>
    /// so the intended day-of-month survives a shorter month (rule 62). Null for Goals.
    /// </summary>
    public DateOnly? CycleDeadline { get; set; }

    /// <summary>
    /// The account that holds this jar's money (rule 2): every jar has exactly one, chosen at
    /// creation (rule 73), and its balance is the allocations posted within that account's
    /// ledger. An enforced foreign key; changing it requires a zero balance (rule 80).
    /// </summary>
    public Guid FundingAccountId { get; set; }
    public Account? FundingAccount { get; set; }

    /// <summary>
    /// Rule 55 (W04): the day the user marked this one-off jar's purpose completed. A completed jar
    /// plans no further contributions — its balance being spent (or reaching zero) never restarts
    /// a plan — and keeps whatever it still holds until the user reallocates it (rule 56).
    /// Completion records no payment and moves no money. Null while the jar is live; never set on
    /// a Recurring jar (its cycles end by being marked paid, rule 83). Reopening is not offered
    /// (HANDOVER O3).
    /// </summary>
    public DateOnly? CompletedOn { get; set; }

    /// <summary>Rule 55: a Goal whose purpose the user has marked completed.</summary>
    public bool IsCompleted => CompletedOn is not null;

    /// <summary>
    /// Archived jars are hidden from active budgeting but kept so past months still reconcile
    /// (rules 25–27): archiving needs a zero balance and cancels the remaining planned
    /// contributions, current month included; restoring plants them again.
    /// </summary>
    public bool IsArchived { get; set; }

    /// <summary>
    /// The day the jar was archived (W05): a month that ended before it reads the jar as it was
    /// then, live, so archiving does not rewrite that month's status (rule 27, P49). Cleared on
    /// restore. Null on a jar archived before the date was recorded: archived on every date.
    /// </summary>
    public DateOnly? ArchivedOn { get; set; }

    /// <summary>A detached shallow copy for a read-time view (P49: a month that is over is judged against the definition it had then, <see cref="JarRevision.ApplyTo"/>). Never attach it to a context.</summary>
    public Jar Copy() => (Jar)MemberwiseClone();
}
