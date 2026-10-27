namespace AllotJar.Application.Budgets.Dtos;

/// <summary>
/// One month in actual money (<see cref="MonthLeftover"/>): <see cref="LeftOver"/> =
/// <see cref="CarriedIn"/> + <see cref="Received"/> − <see cref="Spent"/> − <see cref="IntoJars"/>.
/// </summary>
public class MonthWrapUpDto
{
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>What the months before it left over, counted from the first budget; can be negative.</summary>
    public decimal CarriedIn { get; set; }

    /// <summary>Income received in the month (rule 41).</summary>
    public decimal Received { get; set; }

    /// <summary>Net spending in the month, less what jars paid.</summary>
    public decimal Spent { get; set; }

    /// <summary>Money moved into jars in the month, net of any moved back out; never the money set aside when a jar was made.</summary>
    public decimal IntoJars { get; set; }

    /// <summary>What the month leaves for the next one; negative when more went out than there was.</summary>
    public decimal LeftOver { get; set; }

    /// <summary>False while the month is still running (the figures are so far).</summary>
    public bool IsOver { get; set; }

    /// <summary>Rows in the month still waiting for their budget-currency amount, left out of every figure.</summary>
    public int FxPendingCount { get; set; }
}
