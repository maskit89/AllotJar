namespace AllotJar.Domain.Enums;

/// <summary>
/// Where an identified own-account transfer stands, derived from its recorded bank legs.
/// The status describes recorded evidence; it never moves money by itself.
/// </summary>
public enum TransferStatus
{
    /// <summary>Both banks have posted: the source leg on its departure date, the destination leg on its receipt date.</summary>
    Completed = 0,

    /// <summary>Departure is confirmed and receipt is not yet: the amount belongs to neither account (rule 69/71).</summary>
    InTransit = 1,

    /// <summary>Receipt is known but departure is not: held for review with no posted effect on either account (rule 72).</summary>
    PendingReview = 2,
}
