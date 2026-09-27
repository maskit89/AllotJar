using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A single budget line (e.g. "Rent", "Groceries") that belongs to a category.
/// Currency amounts are stored as <see cref="decimal"/> and mapped to
/// SQL Server decimal(18,4) so no precision is lost on Euro cents.
/// </summary>
public class BudgetItem : BaseEntity
{
    public Guid BudgetCategoryId { get; set; }
    public BudgetCategory BudgetCategory { get; set; } = null!;

    public string Name { get; set; } = string.Empty;

    /// <summary>The amount the user has assigned/planned for this line this month.</summary>
    public decimal PlannedAmount { get; set; }

    /// <summary>
    /// The amount spent (or, for an income line, received) so far. Always derived
    /// at read time (see AllotJar.Application.Budgets.BudgetActuals) from the
    /// transactions assigned to this line — whole transactions of the line's kind
    /// plus any split slices. Never authored directly.
    /// </summary>
    public decimal ActualAmount { get; set; }

    /// <summary>
    /// Transient (not persisted): the refunds received against this expense/savings line (rules
    /// 38/39), already subtracted from <see cref="ActualAmount"/> — so the line can say "spent
    /// 80.00 after 20.00 refunded" and a negative Spent is explicable. Always 0 on income lines.
    /// Derived at read time (see AllotJar.Application.Budgets.BudgetActuals).
    /// </summary>
    public decimal RefundedAmount { get; set; }

    /// <summary>
    /// For a line in a <see cref="CategoryKind.Savings"/> group: a stable id shared by
    /// every month's instance of the same sinking fund, so its balance can roll over.
    /// Generated when the fund line is first created and preserved when a month is
    /// copied. Null for ordinary income/expense lines.
    /// </summary>
    public Guid? SavingsId { get; set; }
    public Jar? Jar { get; set; }

    /// <summary>
    /// Transient (not persisted): for a fund line, the running available balance of
    /// the fund as of this month — the sum of every contribution (planned) minus
    /// every spend (actual) across all months up to and including this one. Null for
    /// non-fund lines. Derived at read time (see
    /// AllotJar.Application.Budgets.BudgetActuals).
    /// </summary>
    public decimal? SavingsAvailable { get; set; }

    /// <summary>
    /// The day of the month (1–31) this line is due, when it is tracked as a bill.
    /// Null for lines that aren't bills. Recurs month to month (copied when a month
    /// is created); the matching <see cref="IsPaid"/> resets each month.
    /// </summary>
    public int? DueDay { get; set; }

    /// <summary>
    /// Whether this month's instance of the bill has been paid. Only meaningful when
    /// <see cref="DueDay"/> is set. Resets to false when a new month is created.
    /// </summary>
    public bool IsPaid { get; set; }

    /// <summary>True when this line is tracked as a bill (it has a due day).</summary>
    public bool IsBill => DueDay is not null;

    /// <summary>
    /// The household member this line belongs to. On an INCOME line: who earns it — the
    /// budget-side half of per-person income (null = whole-household / unattributed). On an
    /// EXPENSE line: whose pocket-money allowance it is — written only by the pocket-money sync
    /// (rule 53: the link is the person's id, never their name, so a rename reuses the line and
    /// archiving stops it, rule 54). Always null on savings lines. Carried when a month is copied,
    /// except that an archived person's pocket-money line is dropped.
    /// </summary>
    public Guid? MemberId { get; set; }

    public int DisplayOrder { get; set; }

    public ICollection<Transaction> Transactions { get; set; } = new List<Transaction>();

    /// <summary>
    /// Positive when there is budget left on the line, negative when overspent.
    /// </summary>
    public decimal Remaining => PlannedAmount - ActualAmount;
}
