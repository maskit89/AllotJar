namespace AllotJar.Application.Imports.Models;

/// <summary>
/// Summary of what an import did. <paramref name="Transfers"/> counts transfer rows recorded
/// or confirmed; <paramref name="MatchedTransfers"/> is the subset that confirmed the other side
/// of an existing transfer (no new transaction); <paramref name="PendingReviewTransfers"/> the
/// subset held for review because only the receipt is known (rule 72); <paramref name="Returned"/>
/// the rows that confirmed a transfer coming back to its source (O1 answer 4). <paramref name="AwaitingAmount"/> counts the new rows in another currency that wait for their budget-currency amount (rules 42/44). <paramref name="Held"/>
/// lists the rows not imported because posting them would take the statement account below
/// zero on some date (rules 11/74): each names the reason, so the user records the missing
/// deposit and re-commits it, corrects it, or discards it; nothing is posted "anyway".
/// <paramref name="SkippedReferences"/> names the rows counted in <paramref name="SkippedDuplicates"/>
/// by the reference the request sent, so the screen's money totals can leave them out.
/// </summary>
public record ImportStatementResult(
    int TotalEntries,
    int Imported,
    int SkippedDuplicates,
    int Credits,
    int Debits,
    string? Iban,
    int AutoCategorized = 0,
    int Transfers = 0,
    int MatchedTransfers = 0,
    int PendingReviewTransfers = 0,
    IReadOnlyList<ImportHeldRow>? Held = null,
    int Returned = 0,
    int AwaitingAmount = 0,
    IReadOnlyList<string>? SkippedReferences = null)
{
    public IReadOnlyList<ImportHeldRow> Held { get; init; } = Held ?? [];
    public IReadOnlyList<string> SkippedReferences { get; init; } = SkippedReferences ?? [];
    public int HeldCount => Held.Count;
}

/// <summary>A statement row held back from an import (rule 74) and why.</summary>
public record ImportHeldRow(string Reference, string Message);
