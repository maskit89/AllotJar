using MediatR;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Application.Imports.Commands.ImportStatement;

/// <summary>
/// Imports a bank statement for the current user. <paramref name="Format"/> selects the
/// parser (CAMT.053 XML or HSBC CSV). When an <paramref name="AccountId"/> is given, every
/// imported transaction is stamped with that account so its balance reflects the statement.
/// </summary>
public record ImportStatementCommand(
    string Content,
    Guid? AccountId = null,
    StatementFormat Format = StatementFormat.Camt053) : IRequest<ImportStatementResult>;

/// <summary>
/// Summary of what an import did. <paramref name="Transfers"/> counts transfer rows recorded
/// or confirmed; <paramref name="MatchedTransfers"/> is the subset that confirmed the other side
/// of an existing transfer (no new transaction); <paramref name="PendingReviewTransfers"/> the
/// subset held for review because only the receipt is known (rule 72).
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
    int PendingReviewTransfers = 0);
