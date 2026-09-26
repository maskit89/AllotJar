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
}
