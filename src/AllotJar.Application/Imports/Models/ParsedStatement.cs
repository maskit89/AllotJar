namespace AllotJar.Application.Imports.Models;

/// <summary>A single booked entry parsed from a bank statement.</summary>
public record ParsedStatementEntry(
    decimal Amount,
    string Currency,
    bool IsCredit,
    DateOnly BookingDate,
    string Payee,
    string? Reference);

/// <summary>A parsed bank statement: the account it belongs to and its entries.</summary>
public record ParsedStatement(
    string? Iban,
    IReadOnlyList<ParsedStatementEntry> Entries);
