using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.CreateTransaction;

/// <summary>
/// Creates a transaction the user entered by hand in the sheet (in the budget's
/// base currency). Optionally assigns it to a budget line — whose Spent then
/// includes it — and/or to an account. When <c>Splits</c> is given (two or more
/// slices summing exactly to <c>Amount</c>), the transaction is created already
/// split; <c>BudgetItemId</c> and <c>MemberId</c> must then be null — the slices
/// carry the attribution. On an account that backs jars, <c>JarAllocations</c> is the answer to
/// the incoming-money prompt (rule 78: how much of an income goes to each jar, the rest
/// unallocated) and <c>PaidFromJarId</c> the answer to "which jar does this come from?" for an
/// expense on a line that is not a jar (rule 79; unallocated when null). With
/// <c>RefundOfTransactionId</c> the row is a refund of that purchase (rules 38/39): money received
/// (<c>Type</c> must be Income) that is never income, lands by default on the line that continues
/// the purchase's line in its own month, and can't be split. Returns the created transaction.
/// </summary>
[AllowLimited]
public record CreateTransactionCommand(
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? BudgetItemId,
    Guid? AccountId = null,
    Guid? MemberId = null,
    IReadOnlyList<SplitAllocationInput>? Splits = null,
    // Set only after the user confirms budgeting to a line in a different month than the
    // transaction's date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false,
    IReadOnlyList<JarAllocationInput>? JarAllocations = null,
    Guid? PaidFromJarId = null,
    Guid? RefundOfTransactionId = null) : IRequest<TransactionDto>;
