using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.AssignTransaction;

/// <summary>
/// Assigns a transaction to a budget line (or clears the assignment when
/// <paramref name="BudgetItemId"/> is null). The line's actual spending then
/// reflects this transaction on the next budget read.
/// </summary>
[AllowLimited]
public record AssignTransactionCommand(Guid TransactionId, Guid? BudgetItemId)
    : IRequest<TransactionDto>;
