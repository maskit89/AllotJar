using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A sinking fund: a periodic or one-off expense target that is saved towards a
/// little each month and spent against over time (e.g. "Home Insurance €300/yr",
/// "Yearly Holiday €4000"). It owns the fund's <see cref="TargetAmount"/>, due date
/// and <see cref="AccrualMethod"/>; each month's contribution to it is an ordinary
/// <see cref="BudgetItem"/> in a <see cref="CategoryKind.Savings"/> group whose
/// <see cref="BudgetItem.SavingsId"/> equals this fund's <see cref="BaseEntity.Id"/>.
///
/// The running balance is NOT stored here — it is derived at read time as
/// <see cref="OpeningBalance"/> plus every contribution minus every spend across all
/// months (see AllotJar.Application.Budgets.BudgetActuals), so it rolls over without
/// drifting. This entity holds only the fund's definition.
/// </summary>
public class Jar : BaseEntity
{
    /// <summary>Identity user id that owns this fund (the household).</summary>
    public string OwnerId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public JarKind Kind { get; set; } = JarKind.Recurring;

    /// <summary>The amount to accumulate (spreadsheet col B). Mapped to decimal(18,4).</summary>
    public decimal TargetAmount { get; set; }

    /// <summary>When the money is needed by — drives <see cref="AccrualMethod.TargetByDate"/>. Null for open-ended funds.</summary>
    public DateOnly? TargetDate { get; set; }

    /// <summary>Start of a commitment's cover window (e.g. an insurance policy period). Null when not applicable.</summary>
    public DateOnly? CoverStart { get; set; }

    /// <summary>End of the cover window. With <see cref="CoverStart"/> it sets the straight-line divisor.</summary>
    public DateOnly? CoverEnd { get; set; }

    /// <summary>How the required monthly contribution is computed. Defaults to <see cref="AccrualMethod.TargetByDate"/>.</summary>
    public AccrualMethod Accrual { get; set; } = AccrualMethod.TargetByDate;

    /// <summary>
    /// True when the jar renews each cycle rather than ending at its target. Derived from
    /// <see cref="Kind"/> (Recurring ⇒ true, Goal ⇒ false) by the create/update handlers,
    /// so it is never set independently of the jar's type.
    /// </summary>
    public bool RecurAnnually { get; set; }

    /// <summary>
    /// Progress already accumulated before tracked contributions begin — used to seed
    /// historical progress at import without importing pre-history. Mapped to decimal(18,4).
    /// </summary>
    public decimal OpeningBalance { get; set; }

    /// <summary>The date <see cref="OpeningBalance"/> was measured as of. Null when there is no opening.</summary>
    public DateOnly? OpeningAsOf { get; set; }

    /// <summary>
    /// The physical account that holds this fund's cash, if any. A soft hint for the UI
    /// and reconciliation only — intentionally NOT a foreign key, so the budget envelope
    /// and the account ledger stay independent (see the two-ledger reconciliation design).
    /// </summary>
    public Guid? FundingAccountId { get; set; }

    /// <summary>Archived funds are hidden from active budgeting but kept so past months still reconcile.</summary>
    public bool IsArchived { get; set; }
}
