namespace AllotJar.Application.Imports;

/// <summary>
/// A cheap, conservative guess at whether an imported row is a transfer between the user's own
/// accounts rather than real income/spending — used only to <em>hint</em> in the review UI; the
/// user always confirms and picks the counterparty account. HSBC's e-banking top-ups show up as
/// "E-BANKING PAYMENT", which is the common false-positive-as-income case.
/// </summary>
public static class TransferHeuristic
{
    private static readonly string[] Markers =
    {
        "E-BANKING PAYMENT",
        "INTERNAL TRANSFER",
        "TRANSFER TO",
        "TRANSFER FROM",
        "OWN ACCOUNT",
    };

    public static bool IsLikelyTransfer(string? payee)
    {
        if (string.IsNullOrWhiteSpace(payee))
        {
            return false;
        }
        var upper = payee.ToUpperInvariant();
        return Markers.Any(m => upper.Contains(m, StringComparison.Ordinal));
    }
}
