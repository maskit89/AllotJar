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
/// The actual balance is NOT stored here — it is derived at read time from the
/// designated account's recorded money and the jar allocations posted against it
/// (see AllotJar.Domain.Services.ActualSavingsLedger and the Application JarLedgerReader).
/// Planned contributions never count as money (rule 1). This entity holds only the
/// jar's definition.
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
    /// A Recurring jar's cycle length in months: when its <see cref="TargetDate"/>
    /// passes, the date rolls forward by this many months and the jar keeps saving
    /// (see Services.JarAccrualCalculator.EffectiveTargetDate). Null for
    /// <see cref="JarKind.Goal"/> jars, which end at their target instead of renewing —
    /// the create/update handlers keep it in lockstep with <see cref="Kind"/>.
    /// </summary>
    public int? RecurMonths { get; set; }

    /// <summary>
    /// The account that holds this jar's money (rule 2): every jar has exactly one, chosen at
    /// creation (rule 73), and its balance is the allocations posted within that account's
    /// ledger. An enforced foreign key; changing it requires a zero balance (rule 80).
    /// </summary>
    public Guid FundingAccountId { get; set; }
    public Account? FundingAccount { get; set; }

    /// <summary>Archived funds are hidden from active budgeting but kept so past months still reconcile.</summary>
    public bool IsArchived { get; set; }
}
