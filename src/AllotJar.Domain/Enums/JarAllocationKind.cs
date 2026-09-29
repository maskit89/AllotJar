namespace AllotJar.Domain.Enums;

/// <summary>Why a <see cref="Entities.JarAllocation"/> exists. Stored as int.</summary>
public enum JarAllocationKind
{
    /// <summary>Money already in the account divided into a jar at setup (rules 9/77). Zero-sum: jar +X, unallocated −X.</summary>
    InitialAllocation = 0,

    /// <summary>A same-account move between jars and/or unallocated funds (rules 6/68/70). Zero-sum.</summary>
    Reallocation = 1,

    /// <summary>The jar split of one account leg of a recorded transaction (rules 3/4/78/79). Sums to the movement.</summary>
    Movement = 2,

    /// <summary>
    /// Rule 80: the jar left this account on <see cref="Entities.JarAllocation.Date"/>. Zero-sum, always two postings:
    /// the jar −S and unallocated +S, where S is what the account's other operations still leave in the jar
    /// on that date (0 when written; a later correction of a kept pre-move leg moves it here).
    /// </summary>
    Departure = 3,

    /// <summary>
    /// A returned transfer's money going back to the jars it left from (O1 answer 4): jar +S,
    /// unallocated −S, dated the return, linked by <see cref="Entities.JarAllocation.ReturnOfTransferId"/>.
    /// Decided when the return is recorded, from the jars as they are then, so a later archive,
    /// move or restore never rewrites it. The return leg itself posts to unallocated.
    /// </summary>
    Return = 4,
}
