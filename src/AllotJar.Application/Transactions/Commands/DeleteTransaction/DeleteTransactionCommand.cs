using MediatR;
using AllotJar.Application.Common.Security;

namespace AllotJar.Application.Transactions.Commands.DeleteTransaction;

/// <summary>Deletes one of the user's transactions.</summary>
[AllowLimited]
public record DeleteTransactionCommand(Guid TransactionId) : IRequest<DeleteTransactionResult>;

/// <summary>
/// The delete was done; <paramref name="Warning"/>, when set, says what it left behind for the
/// user to settle, e.g. jars no longer backed by the account's money (D10, rule 70).
/// </summary>
public record DeleteTransactionResult(string? Warning);
