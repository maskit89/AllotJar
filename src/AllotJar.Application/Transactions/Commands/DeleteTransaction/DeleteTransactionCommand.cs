using MediatR;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.Transactions.Commands.DeleteTransaction;

/// <summary>Deletes one of the user's transactions.</summary>
[AllowLimited]
public record DeleteTransactionCommand(Guid TransactionId) : IRequest;
