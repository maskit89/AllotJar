using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// One closed cycle of a <see cref="JarKind.Recurring"/> <see cref="Jar"/> (W03): the deadline it
/// worked toward, the target it had, how it ended and — when the user marked it paid — the
/// payment that fulfilled it (rule 83). The jar's open cycle is not a row: it is
/// <see cref="Jar.CycleDeadline"/>. Closing a cycle never moves money (rules 20–23): the
/// balance the jar holds simply carries into the next cycle (rule 19).
/// </summary>
public class JarCycle : BaseEntity
{
    public string OwnerId { get; set; } = string.Empty;

    public Guid JarId { get; set; }
    public Jar Jar { get; set; } = null!;

    /// <summary>The deadline this cycle worked toward (a plain calendar date, rule 82).</summary>
    public DateOnly Deadline { get; set; }

    /// <summary>The jar's target when the cycle closed, which its outcome was judged against (rule 24: the next cycle keeps it unless edited).</summary>
    public decimal TargetAmount { get; set; }

    public JarCycleOutcome Outcome { get; set; }

    /// <summary>
    /// The jar's balance at the end of the day before the deadline — what was in the account
    /// when the money had to be there (rule 82). Null when the account's balance was
    /// unavailable for that date (rule 67).
    /// </summary>
    public decimal? BalanceAtDeadline { get; set; }

    /// <summary>The payment the user chose as fulfilling this cycle (rule 83); null unless <see cref="Outcome"/> is <see cref="JarCycleOutcome.Paid"/>.</summary>
    public Guid? PaymentTransactionId { get; set; }
    public Transaction? PaymentTransaction { get; set; }

    /// <summary>The chosen payment's date and base-currency amount, kept here so the record survives the transaction's later deletion.</summary>
    public DateOnly? PaidOn { get; set; }
    public decimal? PaidAmount { get; set; }

    /// <summary>The day the cycle closed: the deadline itself for an automatic rollover, else the day the user acted.</summary>
    public DateOnly ClosedOn { get; set; }

    public DateTime CreatedUtc { get; set; }

    /// <summary>
    /// The cycle was due in a month given without a day (<see cref="Jar.MonthOnly"/>, kept as it
    /// stood when the cycle closed): it was on time until that month was over
    /// (<see cref="Services.JarSchedule.LateFrom"/>).
    /// </summary>
    public bool MonthOnly { get; set; }

    /// <summary>A paid cycle whose payment landed before the deadline (rule 22), or within its month for a month given without a day.</summary>
    public bool PaidOnTime => Outcome == JarCycleOutcome.Paid && PaidOn is { } paid && paid < Services.JarSchedule.LateFrom(Deadline, MonthOnly);

    /// <summary>
    /// The day the cycle counts as closed when a past month is read (W05, P49): a cycle paid on
    /// time was complete from its payment (rule 22) even when the user marked it paid later
    /// (rule 83), so no month after the payment reads it Deadline missed; otherwise
    /// <see cref="ClosedOn"/>.
    /// </summary>
    public DateOnly ClosedForHistoryOn => PaidOnTime && PaidOn is { } paid && paid < ClosedOn ? paid : ClosedOn;
}
