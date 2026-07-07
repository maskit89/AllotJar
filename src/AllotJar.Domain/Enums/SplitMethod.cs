namespace AllotJar.Domain.Enums;

/// <summary>How a shared cost — or the savings remainder — is divided across household members.</summary>
public enum SplitMethod
{
    /// <summary>Divided equally (the spreadsheet's 50/50).</summary>
    Equal = 0,

    /// <summary>Divided in proportion to each member's net income.</summary>
    ByIncomeRatio = 1,

    /// <summary>
    /// Savings only: tilt the remainder toward whoever's savings account is lower so the
    /// balances converge over time. Gentle — both members always save something; how hard
    /// it leans is set by the profile's BalanceLeanPercent. See <see cref="Services.IncomeAllocator"/>.
    /// </summary>
    BalanceTilt = 2
}
