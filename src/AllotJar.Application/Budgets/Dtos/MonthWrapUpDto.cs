namespace AllotJar.Application.Budgets.Dtos;

/// <summary>
/// One month in actual money (<see cref="MonthMoney"/>): <see cref="LeftOver"/> =
/// <see cref="CarriedIn"/> + <see cref="NewAccounts"/> + <see cref="Received"/> − <see cref="Spent"/>
/// − <see cref="IntoJars"/> + <see cref="PrivateTransfers"/>.
/// </summary>
public class MonthWrapUpDto
{
    public int Year { get; set; }
    public int Month { get; set; }

    /// <summary>What every month before it left over: money in the accounts with no job; can be negative.</summary>
    public decimal CarriedIn { get; set; }

    /// <summary>What accounts opened in the month held when they were opened, less what their earlier rows already counted.</summary>
    public decimal NewAccounts { get; set; }

    /// <summary>Income received in the month (rule 41).</summary>
    public decimal Received { get; set; }

    /// <summary>Net spending in the month, less what jars paid; negative when refunds came to more.</summary>
    public decimal Spent { get; set; }

    /// <summary>Money put into jars in the month, net of any taken out (negative when more came out).</summary>
    public decimal IntoJars { get; set; }

    /// <summary>The part of <see cref="IntoJars"/> set aside when a jar was made.</summary>
    public decimal SetAside { get; set; }

    /// <summary>Money moved in from (+) or out to (−) private accounts.</summary>
    public decimal PrivateTransfers { get; set; }

    /// <summary>What the month leaves for the next one; negative when more went out than there was.</summary>
    public decimal LeftOver { get; set; }

    /// <summary>
    /// What the month's budget gives a job besides its income (the "From" line, counted in
    /// Remaining to budget): <see cref="CarriedIn"/>, plus money that reached the accounts outside
    /// the plan (<see cref="NewAccounts"/>, <see cref="PrivateTransfers"/>), less <see cref="SetAside"/>.
    /// </summary>
    public decimal ToAllot { get; set; }

    /// <summary>Rows in the month still waiting for their budget-currency amount, left out of every figure.</summary>
    public int FxPendingCount { get; set; }
}
