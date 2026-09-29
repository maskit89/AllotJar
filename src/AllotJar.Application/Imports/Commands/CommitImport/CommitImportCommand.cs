using MediatR;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Jars;

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
/// <param name="TransferAccountId">
/// When set, the row is an own-account transfer between the import account and this
/// counterparty (direction follows <see cref="IsCredit"/>). A debit records the confirmed
/// departure leg; a credit records the receipt leg only and is held for review until its
/// departure is supplied (rule 72). See the commit handler.
/// </param>
/// <param name="MatchTransferId">
/// The recorded transfer this row confirms the other side of, chosen by the user from the
/// preview's candidates (rules 50/51). The row's date and reference are attached to that
/// transfer's open leg and no new transaction is created. Requires
/// <paramref name="TransferAccountId"/> to name the same counterparty.
/// </param>
/// <param name="JarAllocations">
/// For a credit into a jar-backed statement account (an income, or a transfer receipt this row
/// records or confirms): how much goes to each of that account's jars, the rest unallocated
/// (rule 78). Null or empty leaves it all unallocated.
/// </param>
/// <param name="PaidFromJarId">
/// For a debit from a jar-backed statement account on a line that is not a jar (or a transfer
/// out of it): the jar the money comes from; unallocated when null (rule 79).
/// </param>
/// <param name="Fee">
/// A transfer's explicit fee (O1 answer 5): on a debit recorded as a new transfer, the part of
/// the row that is a fee (the transfer is the rest); with <paramref name="MatchTransferId"/>, the
/// candidate's fee, which the user accepts. Recorded as an expense on
/// <paramref name="FeeBudgetItemId"/>, or uncategorised.
/// </param>
/// <param name="ReturnOfTransferId">
/// For a credit on a transfer's source account: the recorded transfer the bank sent back (O1
/// answer 4). The row confirms the return; nothing else is recorded.
/// </param>
/// <param name="AcknowledgeCrossMonth">
/// Set only after the user confirms budgeting this row (or its slices) to a line in a
/// different month than the row's date (see TransactionInvariants.CrossMonthKey).
/// </param>
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
    Guid? TransferAccountId = null,
    bool AcknowledgeCrossMonth = false,
    Guid? MatchTransferId = null,
    IReadOnlyList<JarAllocationInput>? JarAllocations = null,
    Guid? PaidFromJarId = null,
    decimal? Fee = null,
    Guid? FeeBudgetItemId = null,
    Guid? ReturnOfTransferId = null);

/// <summary>
/// Persists the rows the user kept after reviewing an import. Idempotent: any row whose
/// <see cref="CommitImportItem.Reference"/> this statement account already knows is skipped, so a
/// double-submit (or a later re-import) never duplicates. <see cref="AccountId"/> stamps every
/// row onto one account.
/// </summary>
public record CommitImportCommand(Guid? AccountId, IReadOnlyList<CommitImportItem> Items)
    : IRequest<ImportStatementResult>;
