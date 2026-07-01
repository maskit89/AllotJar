namespace AllotJar.Domain.Enums;

/// <summary>
/// A step in the income-allocation waterfall (modelling the spreadsheet's Future
/// Savings sheet). Rules run in order, each deducting from every member's running
/// balance; the final <see cref="SplitRemainderToMembers"/> sends what's left to each
/// member's personal savings.
/// </summary>
public enum AllocationRuleType
{
    /// <summary>Fund the month's shared living envelopes (sum of Expense-category planned).</summary>
    FundEnvelopes = 0,

    /// <summary>Fund the month's jar contributions (sum of Savings-category planned).</summary>
    FundJars = 1,

    /// <summary>A fixed amount each member keeps/pays (e.g. pocket money).</summary>
    FixedPerMember = 2,

    /// <summary>Terminal: each member's remaining balance becomes their savings.</summary>
    SplitRemainderToMembers = 3
}
