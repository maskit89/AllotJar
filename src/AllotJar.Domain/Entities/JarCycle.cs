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

    /// <summary>The jar's target while this cycle was open (rule 24: the next cycle keeps it unless edited).</summary>
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

    /// <summary>A paid cycle whose payment landed before the deadline (rule 22).</summary>
    public bool PaidOnTime => Outcome == JarCycleOutcome.Paid && PaidOn is { } paid && paid < Deadline;
}
