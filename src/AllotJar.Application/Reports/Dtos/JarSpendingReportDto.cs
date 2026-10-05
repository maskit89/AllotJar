namespace AllotJar.Application.Reports.Dtos;

/// <summary>
/// How much was spent from each jar in one calendar year, month by month: every expense that
/// drew from the jar (a payment on its Savings line, a slice on that line, or a payment on another
/// line answered "from this jar", rule 79), by the expense's own date, net of the refunds that came
/// back into the jar (rule 38). Moves between jars and transfers are not spending (a jar topped up
/// from another jar spent nothing); a row still waiting for its amount in the budget currency
/// counts nowhere until it is entered. Every live jar is listed, with zeros; an archived or
/// completed jar only when the year has a figure for it.
/// </summary>
public class JarSpendingReportDto
{
    public int Year { get; set; }

    /// <summary>Live jars first, then archived, each in name order.</summary>
    public List<JarSpendingRowDto> Jars { get; set; } = new();

    /// <summary>Rows in another currency still waiting for their budget-currency amount, which drew from a jar and are left out.</summary>
    public int WaitingCount { get; set; }
}

public class JarSpendingRowDto
{
    public Guid JarId { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>The currency of the account that holds the jar; the figures are in it.</summary>
    public string Currency { get; set; } = string.Empty;

    public bool IsArchived { get; set; }

    /// <summary>Always 12 entries, January → December: spent net of refunds.</summary>
    public List<decimal> Months { get; set; } = new();

    /// <summary>Always 12 entries, January → December: the refunds already netted out of <see cref="Months"/>.</summary>
    public List<decimal> Refunds { get; set; } = new();

    /// <summary>Σ <see cref="Months"/>.</summary>
    public decimal Total { get; set; }

    /// <summary>Σ <see cref="Refunds"/>.</summary>
    public decimal TotalRefunds { get; set; }
}
