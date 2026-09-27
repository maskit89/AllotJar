namespace AllotJar.Application.Accounts.Dtos;

/// <summary>
/// Reconciles a physical account against the jars it backs: the account's actual
/// balance, the signed total of its jars' actual balances and the unallocated remainder
/// (<see cref="Float"/>), which always sum to the balance. (Promotes the spreadsheet's
/// manual "check" rows.)
/// </summary>
public class AccountReconciliationDto
{
    public Guid AccountId { get; set; }
    public string AccountName { get; set; } = string.Empty;

    /// <summary>The account's actual balance as of today (opening at its opening date plus posted legs); null when unavailable.</summary>
    public decimal? CurrentBalance { get; set; }

    /// <summary>Signed total of the active jars held in this account (negative jars stay visible, rule 70).</summary>
    public decimal BackedJarsTotal { get; set; }

    /// <summary>How many jars this account backs.</summary>
    public int BackedJarCount { get; set; }

    /// <summary>The account's unallocated money: balance minus every jar's signed balance (rule 3); null when unavailable.</summary>
    public decimal? Float { get; set; }

    /// <summary>True when positive jar balances exceed the account's money (rule 70): an explicit reallocation must cover the deficit.</summary>
    public bool HasBackingDeficit { get; set; }

    /// <summary>True when a pending transfer receipt means the posted balance is not yet reconcilable with the bank.</summary>
    public bool RequiresReview { get; set; }
}
