namespace AllotJar.Application.Accounts.Dtos;

/// <summary>
/// Reconciles a physical account against the jars it backs: the account's actual
/// balance vs the total balance of the jars whose money should sit in it. The
/// <see cref="Float"/> is the difference — unallocated cash when positive, a shortfall
/// when negative. (Promotes the spreadsheet's manual "check" rows.)
/// </summary>
public class AccountReconciliationDto
{
    public Guid AccountId { get; set; }
    public string AccountName { get; set; } = string.Empty;

    /// <summary>The account's actual balance as of today (opening at its opening date plus posted legs); null when unavailable.</summary>
    public decimal? CurrentBalance { get; set; }

    /// <summary>Total balance of the jars that name this account as their funding account.</summary>
    public decimal BackedJarsTotal { get; set; }

    /// <summary>How many jars this account backs.</summary>
    public int BackedJarCount { get; set; }

    /// <summary>CurrentBalance − BackedJarsTotal: unallocated float (or a shortfall when negative); null when the balance is unavailable.</summary>
    public decimal? Float { get; set; }

    /// <summary>True when a pending transfer receipt means the posted balance is not yet reconcilable with the bank.</summary>
    public bool RequiresReview { get; set; }
}
