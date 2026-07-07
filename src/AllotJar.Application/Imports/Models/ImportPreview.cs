namespace AllotJar.Application.Imports.Models;

/// <summary>
/// A single not-yet-imported transaction the user can review, categorise and attribute
/// before committing. <see cref="Reference"/> is the parser's synthesized idempotency key,
/// echoed back unchanged on commit so the server can persist exactly these rows.
/// <see cref="PossibleDuplicate"/> is a content-level hint (amount + payee + nearby date match
/// an existing transaction) for rows whose reference did NOT match — e.g. the same statement
/// previously imported through a different format/mapping; the UI unticks these by default.
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
    bool PossibleDuplicate = false);

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
