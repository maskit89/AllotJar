using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A real money movement. Expenses are typically linked to the budget line
/// they were spent against; income transactions may stand alone.
/// </summary>
public class Transaction : BaseEntity, IVersioned
{
    /// <inheritdoc />
    public byte[] Version { get; set; } = [];

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
    /// For a refund (rules 38/39): the original expense this money comes back from. A refund is
    /// money reaching the account on its own date (<see cref="Type"/> is <see cref="TransactionType.Income"/>),
    /// but it is never income: it reduces net spending in the original's category in the month it
    /// is received, so it may be assigned to an expense or savings line and never to an income
    /// line, and every income figure leaves it out (rule 41). Null for everything else.
    /// </summary>
    public Guid? RefundOfTransactionId { get; set; }
    public Transaction? RefundOf { get; set; }

    /// <summary>The refunds linked to this expense (rule 38); both sides stay in history.</summary>
    public ICollection<Transaction> Refunds { get; set; } = new List<Transaction>();

    /// <summary>True when this is a refund of an earlier expense (<see cref="RefundOfTransactionId"/> set).</summary>
    public bool IsRefund => RefundOfTransactionId is not null;

    /// <summary>
    /// The household member this whole transaction is attributed to (optional) — e.g. whose
    /// spend it was. When the transaction is split, per-member attribution lives on the
    /// slices instead (<see cref="TransactionSplit.MemberId"/>), mirroring how the budget-line
    /// attribution moves to the slices.
    /// </summary>
    public Guid? MemberId { get; set; }
    public HouseholdMember? Member { get; set; }

    /// <summary>
    /// Amount in the transaction's <see cref="Currency"/>. Positive magnitude; direction is on
    /// <see cref="Type"/>. Once a row counts (<see cref="FxPending"/> false) this is the budget
    /// currency amount, as the bank or the user supplied it (rules 43/85); the app never
    /// converts it. The one exception is a row on an account kept in another currency (from
    /// before rule 63): its amount is that account's money and stays in that currency, and what
    /// it counts in the budget is <see cref="BudgetAmount"/>.
    /// </summary>
    public decimal Amount { get; set; }

    /// <summary>
    /// The currency of <see cref="Amount"/>: the budget currency for every row that counts, the
    /// account's currency for a row on an account, and another currency only while the row
    /// waits for its budget-currency amount (<see cref="FxPending"/>).
    /// </summary>
    public CurrencyCode Currency { get; set; } = CurrencyCode.Eur;

    /// <summary>
    /// True when the row was recorded in another currency and has no amount in the budget
    /// currency yet (rules 42/44). It counts in no budget, report or People figure until the
    /// user enters or confirms that amount (<c>ConfirmConvertedAmount</c>); a suggested
    /// conversion is never applied on its own.
    /// </summary>
    public bool FxPending { get; set; }

    /// <summary>
    /// What was paid in another currency, kept for reference once the budget-currency amount is
    /// known: the foreign amount the user converted, or the one a confirmed waiting row carried.
    /// Never counted; <see cref="Amount"/> is the money.
    /// </summary>
    public decimal? OriginalAmount { get; set; }

    /// <summary>The currency of <see cref="OriginalAmount"/>; set together with it.</summary>
    public CurrencyCode? OriginalCurrency { get; set; }

    /// <summary>
    /// The row's figure in the budget currency when <see cref="Amount"/> is in another one: a row
    /// on an account kept in another currency, whose amount is that account's money and can't be
    /// restated without changing its balance. Set once, by the <c>ForeignAmounts</c> migration
    /// (the figure the row already counted at) or by the user confirming it; never derived from a
    /// rate. Every budget, report, People and refund figure reads it instead of the amount; account
    /// and jar balances keep reading <see cref="Amount"/>. Null on every other row.
    /// </summary>
    public decimal? BudgetAmount { get; set; }

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
    /// The account whose statement carried <see cref="BankReference"/>, kept when the user moves
    /// the row by hand to another account (or off every account), so importing that statement
    /// again still knows the entry (D8, rule 88). Null while the row is on that account. Not a
    /// foreign key: only the import of that account's statement reads it.
    /// </summary>
    public Guid? StatementAccountId { get; set; }

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
    /// For a transfer: the destination account knows this receipt under the source leg's
    /// <see cref="BankReference"/>. Set once, by migration, on transfers recorded before receipt
    /// references existed, when an inbound transfer's reference was stored on the source leg;
    /// never on a receipt confirmed by hand since, so a destination statement that prints the
    /// same reference as the source's confirms that receipt instead of being skipped (rule 51).
    /// Cleared when the receipt gets a reference of its own.
    /// </summary>
    public bool ReceiptKnownBySourceReference { get; set; }

    /// <summary>
    /// The other side of this movement was a private account nobody could reach that the budget
    /// owner erased (P59, "Keep shared"): a transfer's shared side kept as a plain income or
    /// expense so the account's history and statements stay whole. It counts in the account's
    /// ledger and nowhere else, as the transfer it was: the reports and the register's totals
    /// skip it, like a transfer.
    /// </summary>
    public bool CounterpartyErased { get; set; }

    /// <summary>
    /// For a transfer the source bank sent back (O1 answer 4): the date the money was credited
    /// back to the source account. Only for a transfer that departed and was never received; the
    /// destination never receives it and nothing is in transit from this date.
    /// </summary>
    public DateOnly? ReturnedOn { get; set; }

    /// <summary>For a returned transfer: the source statement's own reference for the credit back.</summary>
    public string? ReturnBankReference { get; set; }

    /// <summary>
    /// What the bank's statement printed under <see cref="BankReference"/> (<c>yyyy-MM-dd|amount|C</c>
    /// or <c>|D</c>), kept the first time the user changes this row's date, amount or direction,
    /// so importing that statement again still recognises the entry (rule 88). Null while the row
    /// reads as the bank printed it.
    /// </summary>
    public string? BankEntry { get; set; }

    /// <summary>
    /// The app's own key for an income-allocation transfer (<c>alloc:{year}-{month}:{member}</c>),
    /// so a re-run finds the transfers it recorded. Kept apart from <see cref="BankReference"/>,
    /// which only ever holds a bank statement's reference.
    /// </summary>
    public string? AllocationKey { get; set; }

    /// <summary>
    /// On a fee row (an expense on the transfer's source account, dated its departure): the
    /// transfer whose explicit fee it is (O1 answer 5). The source is debited the transfer's
    /// amount plus this fee; the destination receives the transfer's amount. A fee row is changed
    /// only through its transfer.
    /// </summary>
    public Guid? FeeForTransferId { get; set; }
    public Transaction? FeeForTransfer { get; set; }

    /// <summary>On a transfer: its fee row, when a fee was supplied.</summary>
    public Transaction? Fee { get; set; }

    /// <summary>
    /// The recorded-evidence status of a transfer (see <see cref="TransferStatus"/>). Only
    /// meaningful when <see cref="Type"/> is <see cref="TransactionType.Transfer"/>.
    /// </summary>
    public TransferStatus TransferStatus => DepartedOn is null
        ? TransferStatus.PendingReview
        : ReceivedOn is not null ? TransferStatus.Completed
        : ReturnedOn is not null ? TransferStatus.Returned
        : TransferStatus.InTransit;

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
