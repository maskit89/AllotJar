namespace AllotJar.Application.Imports.Models;

/// <summary>A single booked entry parsed from a bank statement.</summary>
public record ParsedStatementEntry(
    decimal Amount,
    string Currency,
    bool IsCredit,
    DateOnly BookingDate,
    string Payee,
    string? Reference)
{
    /// <summary>
    /// For a row whose reference the parser made from its own text and that text held a card
    /// number: the reference imports before compliance fix 12 stored for it, hashed over the
    /// unmasked text. Duplicate detection checks it so a statement imported before is still
    /// recognised; it is never stored.
    /// </summary>
    public string? LegacyReference { get; init; }
}

/// <summary>
/// A parsed bank statement: its entries. The statement's own account identifiers (a CAMT.053
/// IBAN) are not read: AllotJar keeps no bank details.
/// <see cref="ResolvedDateFormat"/> is set by the generic CSV importer when it had to auto-detect
/// the file's date format — surfaced so the UI can show (and pin) what was actually applied.
/// <see cref="UnreadLines"/> counts lines with an amount the generic CSV importer could not read
/// as a transaction (no date, or text where the amount should be), so nothing is lost unseen.
/// </summary>
public record ParsedStatement(
    IReadOnlyList<ParsedStatementEntry> Entries,
    string? ResolvedDateFormat = null)
{
    public int UnreadLines { get; init; }
}
