using MediatR;
using AllotJar.Application.Common.Security;
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
/// carry the attribution. Returns the created transaction.
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
    bool AcknowledgeCrossMonth = false) : IRequest<TransactionDto>;
