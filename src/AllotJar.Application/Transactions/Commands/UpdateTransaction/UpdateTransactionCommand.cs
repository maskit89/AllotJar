using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.UpdateTransaction;

/// <summary>
/// Edits a transaction's core fields (date, payee, amount, direction) and its account
/// (null clears it). Budget-line assignment and currency are unchanged. Returns the
/// updated transaction.
/// </summary>
[AllowLimited]
public record UpdateTransactionCommand(
    Guid TransactionId,
    DateOnly Date,
    string Payee,
    decimal Amount,
    TransactionType Type,
    Guid? AccountId = null,
    Guid? MemberId = null) : IRequest<TransactionDto>;
