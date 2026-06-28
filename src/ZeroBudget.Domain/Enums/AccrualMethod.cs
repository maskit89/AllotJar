namespace ZeroBudget.Domain.Enums;

/// <summary>
/// How a <see cref="Entities.Jar"/>'s required monthly contribution is
/// computed. The default, <see cref="TargetByDate"/>, is self-correcting: an
/// under-funded month raises next month's required amount automatically.
/// </summary>
public enum AccrualMethod
{
    /// <summary>
    /// Target ÷ 12 (or ÷ the cover-period length in months when one is set).
    /// Matches the spreadsheet's straight-line commitments (e.g. insurance B/12).
    /// </summary>
    StraightLine = 0,

    /// <summary>
    /// (Target − current balance) ÷ months remaining until the target date, floored
    /// at one month. The mathematically correct sinking-fund rule; recommended default.
    /// </summary>
    TargetByDate = 1,

    /// <summary>
    /// (Target ÷ Σ all pooled targets) × a fixed monthly savings pool. Replicates the
    /// spreadsheet's "distribute €1400/month proportionally across funds" behaviour.
    /// </summary>
    ProportionalPool = 2,

    /// <summary>
    /// Target ÷ 365 × days — the daily accrual rate. Used mainly to prorate an opening
    /// balance from historical progress (spreadsheet Yearly Expenses col J).
    /// </summary>
    DailyRate = 3
}
