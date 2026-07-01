namespace AllotJar.Application.Imports.Models;

/// <summary>
/// A single not-yet-imported transaction the user can review, categorise and attribute
/// before committing. <see cref="Reference"/> is the parser's synthesized idempotency key,
/// echoed back unchanged on commit so the server can persist exactly these rows.
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
    bool LikelyTransfer);

/// <summary>
/// The result of previewing an import: the de-duplicated candidate rows plus the counts the
/// UI shows (how many were parsed, how many are new, how many were already imported).
/// </summary>
public record ImportPreviewResult(
    int TotalEntries,
    int NewCount,
    int SkippedDuplicates,
    int Credits,
    int Debits,
    IReadOnlyList<ImportCandidate> Items);
