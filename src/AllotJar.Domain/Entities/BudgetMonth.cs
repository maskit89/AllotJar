using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Entities;

/// <summary>
/// The aggregate root for a user's budget for one calendar month
/// (identified to the outside world by a key such as "2026-06").
///
/// In zero-based budgeting every Euro of income must be assigned a job,
/// so the goal is to drive <see cref="RemainingToBudget"/> to exactly 0.
/// </summary>
public class BudgetMonth : BaseEntity
{
    /// <summary>Identity (ASP.NET Core Identity) user id that owns this budget.</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>Four digit year, e.g. 2026.</summary>
    public int Year { get; set; }

    /// <summary>Month number 1-12.</summary>
    public int Month { get; set; }

    /// <summary>
    /// The home currency this budget is planned in. Every planned/actual amount
    /// in the tree is expressed in this currency, which keeps the totals summable.
    /// Foreign-currency transactions are converted to this currency before they
    /// affect the budget.
    /// </summary>
    public CurrencyCode BaseCurrency { get; set; } = CurrencyCode.Eur;

    public ICollection<BudgetCategory> Categories { get; set; } = new List<BudgetCategory>();

    /// <summary>Stable, human-readable key such as "2026-06".</summary>
    public string Key => $"{Year:D4}-{Month:D2}";

    /// <summary>
    /// Total income available to allocate this month — the sum of the planned
    /// amounts on every line in the <see cref="CategoryKind.Income"/> groups.
    /// In ZBB this is the pool that gets distributed across the expense lines.
    /// Derived from the income lines so there is a single source of truth.
    /// </summary>
    public decimal TotalIncome =>
        Categories.Where(c => c.Kind == CategoryKind.Income).Sum(c => c.TotalPlanned);

    /// <summary>
    /// Sum of every planned amount across the non-income groups — i.e. how much
    /// income has been given a job. This includes <see cref="CategoryKind.Expense"/>
    /// spending and <see cref="CategoryKind.Savings"/> contributions (putting money into
    /// a sinking fund is giving it a job too), so the budget only balances once funds
    /// are funded. Income lines are excluded so they are never counted as spending.
    /// </summary>
    public decimal TotalPlanned =>
        Categories.Where(c => c.Kind != CategoryKind.Income).Sum(c => c.TotalPlanned);

    /// <summary>
    /// The core ZBB metric: income that has not yet been assigned to a line.
    ///   == 0  -> the budget is perfectly balanced (the goal)
    ///   &gt; 0 -> money still needs a job
    ///   &lt; 0 -> over-budgeted; more was planned than earned
    /// Handles a zero (or absent) income gracefully — it simply returns the
    /// negated total planned, never throwing or dividing.
    /// </summary>
    public decimal RemainingToBudget => TotalIncome - TotalPlanned;

    /// <summary>The same metric as <see cref="RemainingToBudget"/>, carrying its currency.</summary>
    public Money RemainingToBudgetMoney => new(RemainingToBudget, BaseCurrency);

    /// <summary>True when every unit of income is assigned and nothing is over-allocated.</summary>
    public bool IsBalanced => RemainingToBudget == 0m;
}
