using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.UpdateTransaction;

/// <summary>
/// Edits a transaction's core fields (date, payee, amount, direction) and its account
/// (null clears it). Budget-line assignment and currency are unchanged — but a retained
/// assignment (or the slices of a split) is re-validated when the direction or month
/// changes, so an edit can never leave the transaction on a line it could not be assigned
/// to. Returns the updated transaction.
/// </summary>
[AllowLimited]
public record UpdateTransactionCommand(
    Guid TransactionId,
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? AccountId = null,
    Guid? MemberId = null,
    // Set only after the user confirms keeping the assignment/slices on a line in a different
    // month than the edited date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false) : IRequest<TransactionDto>;
