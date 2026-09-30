namespace AllotJar.Application.Imports.Models;

/// <summary>The ways a statement row can confirm a recorded transfer.</summary>
public static class TransferMatchKinds
{
    /// <summary>The row is the other side of the transfer: its departure (a debit) or its receipt (a credit).</summary>
    public const string Match = "Match";

    /// <summary>A credit on the source account: the bank sent the money back (O1 answer 4).</summary>
    public const string Return = "Return";
}

/// <summary>
/// An already recorded transfer that this statement row could confirm a leg of. Only a
/// suggestion (rule 50): the row sits on the transfer's leg in the statement account, in the
/// same currency, and that leg is unknown or was recorded in the app without that bank's
/// reference. The user must select it explicitly on commit; nothing is matched from the amount
/// alone, and a single candidate is never auto-selected. <see cref="Fee"/>, when set, is the
/// transfer's fee after this match (what left beyond what arrived): the user accepts it
/// explicitly and picks its line. <see cref="RecordedDate"/> is the date recorded in the app for
/// that leg, which the statement's date replaces. <see cref="SameReference"/> marks a transfer
/// whose other bank printed this row's reference. <see cref="CounterpartyAccountId"/> is null and
/// the name "Private account" when the other side is private to another login (P57);
/// <see cref="FeeBudgetItemId"/> is the line the transfer's current fee is on, to pre-fill, and
/// <see cref="FeeBudgetItemMonth"/> the first day of that line's budget month: the commit judges
/// the fee's date against it (the bank's departure date, once matched), so the review can ask the
/// cross-month question before sending rather than be refused.
/// </summary>
public record TransferMatchCandidate(
    Guid TransferId,
    Guid? CounterpartyAccountId,
    string CounterpartyAccountName,
    decimal Amount,
    string Currency,
    DateOnly? DepartedOn,
    DateOnly? ReceivedOn,
    string Payee)
{
    public string Kind { get; init; } = TransferMatchKinds.Match;
    public decimal? Fee { get; init; }
    public Guid? FeeBudgetItemId { get; init; }
    public DateOnly? FeeBudgetItemMonth { get; init; }
    public DateOnly? RecordedDate { get; init; }
    public bool SameReference { get; init; }
}

/// <summary>The entry an earlier import recorded under this row's bank reference, with different details.</summary>
public record ReusedReference(DateOnly Date, decimal Amount, bool IsCredit);

/// <summary>
/// A single not-yet-imported transaction the user can review, categorise and attribute
/// before committing. <see cref="Reference"/> is the parser's synthesized idempotency key,
/// echoed back unchanged on commit so the server can persist exactly these rows.
/// <see cref="PossibleDuplicate"/> is a content-level hint (amount + payee + nearby date match
/// an existing transaction) for rows whose reference did NOT match — e.g. the same statement
/// previously imported through a different format/mapping; the UI unticks these by default.
/// <see cref="TransferMatches"/> lists recorded transfers this row could confirm the other
/// side of (populated only when the statement account is known). <see cref="ReusedReference"/>
/// is set when the bank reference was already imported for an entry with different details (O1
/// answer 2): the row is offered, unticked, under a derived <see cref="Reference"/>.
/// </summary>
public record ImportCandidate(
    string Reference,
    DateOnly Date,
    string Payee,
    decimal Amount,
    string Currency,
    bool IsCredit,
    Guid? SuggestedBudgetItemId,
    string? SuggestedBudgetItemName,
    bool LikelyTransfer,
    bool PossibleDuplicate = false,
    IReadOnlyList<TransferMatchCandidate>? TransferMatches = null,
    ReusedReference? ReusedReference = null)
{
    public IReadOnlyList<TransferMatchCandidate> TransferMatches { get; init; } = TransferMatches ?? [];
}

/// <summary>
/// The result of previewing an import: the de-duplicated candidate rows plus the counts the
/// UI shows (how many were parsed, how many are new, how many were already imported).
/// <see cref="Layout"/> is populated only for a generic-CSV preview, so the UI can render the
/// column-mapping controls (and reflect the mapping that produced these rows).
/// <see cref="DetectedFormat"/> names the parser that actually read the file — a "generic"
/// upload that sniffs as a known bank export (e.g. HSBC) is routed to that adapter so the
/// same file always yields the same payees and idempotency references.
/// </summary>
public record ImportPreviewResult(
    int TotalEntries,
    int NewCount,
    int SkippedDuplicates,
    int Credits,
    int Debits,
    IReadOnlyList<ImportCandidate> Items,
    CsvLayout? Layout = null,
    string DetectedFormat = nameof(StatementFormat.GenericCsv));
