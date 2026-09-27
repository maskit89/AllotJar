namespace AllotJar.Domain.Enums;

/// <summary>How a Recurring jar's cycle ended (W03, rules 19–24, 57, 83). Stored as int.</summary>
public enum JarCycleOutcome
{
    /// <summary>
    /// The user marked the cycle paid and chose the payment that fulfilled it (rule 83). A
    /// cycle paid before its deadline counts as met on time whatever the balance on the day
    /// (rule 22); paid after an undismissed missed deadline it is still Paid, just late.
    /// </summary>
    Paid = 1,

    /// <summary>
    /// The target was held when the deadline arrived and the cycle rolled forward on its own
    /// (rule 21); no payment was chosen. The user may still link one to it later.
    /// </summary>
    Funded = 2,

    /// <summary>
    /// The deadline passed short of the target and the user dismissed the notice (rule 20)
    /// without choosing a payment; the jar moved on to its next cycle with whatever it held.
    /// </summary>
    Missed = 3,

    /// <summary>
    /// The target was reached only after the deadline (rule 57) and the user then dismissed
    /// the notice without choosing a payment.
    /// </summary>
    FundedLate = 4,
}
