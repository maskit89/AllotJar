using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.CreateTransfer;

/// <summary>
/// Moves money between two of the user's own accounts. Recorded as a single
/// <see cref="Domain.Enums.TransactionType.Transfer"/> transaction (source =
/// <paramref name="FromAccountId"/>, destination = <paramref name="ToAccountId"/>) that
/// is excluded from budget actuals. Returns the created transaction.
/// </summary>
[AllowLimited]
public record CreateTransferCommand(
    DateOnly Date,
    decimal Amount,
    Guid FromAccountId,
    Guid ToAccountId,
    string? Payee = null) : IRequest<TransactionDto>;
