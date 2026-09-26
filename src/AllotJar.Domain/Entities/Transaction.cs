using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A real money movement. Expenses are typically linked to the budget line
/// they were spent against; income transactions may stand alone.
/// </summary>
public class Transaction : BaseEntity
{
    /// <summary>Identity user id that owns this transaction (denormalised for fast, secure filtering).</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>The budget line this transaction is attributed to (optional for raw income).</summary>
    public Guid? BudgetItemId { get; set; }
    public BudgetItem? BudgetItem { get; set; }

    /// <summary>
    /// The real-world account this money moved in or out of (optional). Drives the
    /// account's derived balance; independent of the budget-line attribution above.
    /// </summary>
    public Guid? AccountId { get; set; }
    public Account? Account { get; set; }

    /// <summary>
    /// For a <see cref="TransactionType.Transfer"/>, the destination account the money moved into
    /// (<see cref="AccountId"/> is the source). Null for ordinary income/expense transactions.
    /// </summary>
    public Guid? TransferAccountId { get; set; }
    public Account? TransferAccount { get; set; }

    /// <summary>
    /// The household member this whole transaction is attributed to (optional) — e.g. whose
    /// spend it was. When the transaction is split, per-member attribution lives on the
    /// slices instead (<see cref="TransactionSplit.MemberId"/>), mirroring how the budget-line
    /// attribution moves to the slices.
    /// </summary>
    public Guid? MemberId { get; set; }
    public HouseholdMember? Member { get; set; }

    /// <summary>Amount in the transaction's own <see cref="Currency"/>. Positive magnitude; direction is on <see cref="Type"/>.</summary>
    public decimal Amount { get; set; }

    /// <summary>The currency the transaction actually happened in (e.g. GBP abroad).</summary>
    public CurrencyCode Currency { get; set; } = CurrencyCode.Eur;

    /// <summary>
    /// Multiplier converting <see cref="Amount"/> into the budget's base currency.
    /// 1 when the transaction is already in the base currency. decimal(18,6).
    /// </summary>
    public decimal ExchangeRate { get; set; } = 1m;

    /// <summary>The amount expressed in the budget's base currency (<see cref="Amount"/> × <see cref="ExchangeRate"/>).</summary>
    public decimal BaseAmount => Amount * ExchangeRate;

    /// <summary>
    /// True when this is a foreign-currency transaction whose exchange rate could NOT be
    /// resolved, so <see cref="ExchangeRate"/> is a placeholder 1 (the amount is counted at face
    /// value in the base currency until reconciled). Distinguishes "genuinely 1:1" from
    /// "unknown rate", so a provider outage no longer silently distorts base-currency totals; a
    /// later resolution pass clears it.
    /// </summary>
    public bool FxPending { get; set; }

    public TransactionType Type { get; set; } = TransactionType.Expense;

    public DateOnly Date { get; set; }

    public string Payee { get; set; } = string.Empty;

    public string? Notes { get; set; }

    /// <summary>
    /// The bank's reference for this entry (ISO 20022 AcctSvcrRef / EndToEndId) on the
    /// <see cref="AccountId"/> account's statement. Used to deduplicate re-imported statements so
    /// importing is idempotent. For a transfer this is the SOURCE account's reference; the
    /// destination statement's reference lives in <see cref="ReceiptBankReference"/> (rule 51).
    /// </summary>
    public string? BankReference { get; set; }

    /// <summary>
    /// For a <see cref="TransactionType.Transfer"/>: the date the source bank posted the debit,
    /// as confirmed by the user or the source statement. Null while the departure is unknown —
    /// a receipt-first import held for review (rule 72). Never inferred from <see cref="Date"/>.
    /// </summary>
    public DateOnly? DepartedOn { get; set; }

    /// <summary>
    /// For a transfer: the date the destination bank posted the credit, as confirmed by the
    /// user or the destination statement. Null while the money is still in transit (rule 71).
    /// </summary>
    public DateOnly? ReceivedOn { get; set; }

    /// <summary>
    /// For a transfer: the destination account statement's own reference for the credit leg,
    /// kept alongside <see cref="BankReference"/> so both statements match one movement (rule 51).
    /// </summary>
    public string? ReceiptBankReference { get; set; }

    /// <summary>
    /// The recorded-evidence status of a transfer (see <see cref="TransferStatus"/>). Only
    /// meaningful when <see cref="Type"/> is <see cref="TransactionType.Transfer"/>.
    /// </summary>
    public TransferStatus TransferStatus => DepartedOn is null
        ? TransferStatus.PendingReview
        : ReceivedOn is null ? TransferStatus.InTransit : TransferStatus.Completed;

    /// <summary>
    /// The slices this transaction is split across. Empty for a normal
    /// (whole) transaction; two or more when the user has split it across
    /// budget lines, in which case <see cref="BudgetItemId"/> is cleared and
    /// the slices carry the per-line attribution instead.
    /// </summary>
    public ICollection<TransactionSplit> Splits { get; set; } = new List<TransactionSplit>();

    /// <summary>True when this transaction is split across budget lines.</summary>
    public bool IsSplit => Splits.Count > 0;

    /// <summary>
    /// The stored jar split of each account leg (at most one per account, rules 78/79). Empty when
    /// the leg's attribution is the derived default: unallocated for incoming money, the budget
    /// line's jar or unallocated for a payment.
    /// </summary>
    public ICollection<JarAllocation> JarAllocations { get; set; } = new List<JarAllocation>();
}
