namespace AllotJar.Application.Accounts.Dtos;

/// <summary>
/// Reconciles a physical account against the jars it backs: the account's
/// derived balance vs the total balance of the jars whose money should sit in it. The
/// <see cref="Float"/> is the difference — unallocated cash when positive, a shortfall
/// when negative. (Promotes the spreadsheet's manual "check" rows.)
/// </summary>
public class AccountReconciliationDto
{
    public Guid AccountId { get; set; }
    public string AccountName { get; set; } = string.Empty;

    /// <summary>The account's derived balance (opening + its transactions).</summary>
    public decimal CurrentBalance { get; set; }

    /// <summary>Total balance of the jars that name this account as their funding account.</summary>
    public decimal BackedJarsTotal { get; set; }

    /// <summary>How many jars this account backs.</summary>
    public int BackedJarCount { get; set; }

    /// <summary>CurrentBalance − BackedJarsTotal: unallocated float (or a shortfall when negative).</summary>
    public decimal Float { get; set; }
}
