using MediatR;
using AllotJar.Application.Imports.Commands.ImportStatement;

namespace AllotJar.Application.Imports.Commands.CommitImport;

/// <summary>One slice of a split import row: a portion of the amount on a budget line, optionally a member.</summary>
public record CommitImportSplit(Guid BudgetItemId, decimal Amount, Guid? MemberId = null);

/// <summary>
/// One reviewed row from a preview, ready to persist. Identity/amount/date fields are echoed
/// back from <see cref="Models.ImportCandidate"/>; <see cref="BudgetItemId"/> and
/// <see cref="MemberId"/> carry the user's categorisation and attribution choices. When
/// <see cref="Splits"/> is given (two or more slices summing to <see cref="Amount"/>), the row is
/// persisted as a split transaction instead — the slices carry the attribution and the
/// whole-transaction line/member are cleared.
/// </summary>
public record CommitImportItem(
    string Reference,
    DateOnly Date,
    string Payee,
    decimal Amount,
    string Currency,
    bool IsCredit,
    Guid? BudgetItemId,
    Guid? MemberId,
    IReadOnlyList<CommitImportSplit>? Splits = null,
    // When set, the row is imported as a transfer between the import account and this counterparty
    // account (direction follows IsCredit) instead of an income/expense — see the commit handler.
    Guid? TransferAccountId = null,
    // Set only after the user confirms budgeting this row (or its slices) to a line in a
    // different month than the row's date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false);

/// <summary>
/// Persists the rows the user kept after reviewing an import. Idempotent: any row whose
/// <see cref="CommitImportItem.Reference"/> already exists is skipped, so a double-submit (or a
/// later re-import) never duplicates. <see cref="AccountId"/> stamps every row onto one account.
/// </summary>
public record CommitImportCommand(Guid? AccountId, IReadOnlyList<CommitImportItem> Items)
    : IRequest<ImportStatementResult>;
