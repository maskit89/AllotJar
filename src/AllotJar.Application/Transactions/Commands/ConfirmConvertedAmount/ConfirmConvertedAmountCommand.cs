using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;

/// <summary>
/// Gives a transaction recorded in another currency its amount in the budget currency (rules
/// 44/85): the amount the user typed, or a suggestion they accepted. Only then does it count.
/// The row becomes a budget-currency row of that amount and keeps the foreign figure for
/// reference. Nothing is derived from the difference between the two (rule 43). Returns the
/// updated transaction.
/// </summary>
[AllowLimited]
public record ConfirmConvertedAmountCommand(Guid TransactionId, decimal Amount) : IRequest<TransactionDto>;
