namespace AllotJar.Application.Imports.Models;

/// <summary>A single booked entry parsed from a bank statement.</summary>
public record ParsedStatementEntry(
    decimal Amount,
    string Currency,
    bool IsCredit,
    DateOnly BookingDate,
    string Payee,
    string? Reference);

/// <summary>
/// A parsed bank statement: the account it belongs to and its entries.
/// <see cref="ResolvedDateFormat"/> is set by the generic CSV importer when it had to auto-detect
/// the file's date format — surfaced so the UI can show (and pin) what was actually applied.
/// </summary>
public record ParsedStatement(
    string? Iban,
    IReadOnlyList<ParsedStatementEntry> Entries,
    string? ResolvedDateFormat = null);
