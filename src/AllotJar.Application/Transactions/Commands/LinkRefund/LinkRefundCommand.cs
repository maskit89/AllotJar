using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.LinkRefund;

/// <summary>
/// Marks money already received as a refund of one of the user's purchases (rules 38/39), or
/// clears that link when <paramref name="RefundOfTransactionId"/> is null. Linking moves the
/// row off any income line onto <paramref name="BudgetItemId"/> when given, else onto the line
/// that continues the purchase's line in the refund's own month (unassigned when there is none),
/// so it reduces net spending there in the month it was received. Unlinking turns the row back
/// into plain income: its expense line is cleared and <paramref name="BudgetItemId"/>, when
/// given, must be an income line. Returns the updated transaction.
/// </summary>
[AllowLimited]
public record LinkRefundCommand(
    Guid TransactionId,
    Guid? RefundOfTransactionId,
    Guid? BudgetItemId = null,
    // Set only after the user confirms budgeting to a line in a different month than the
    // transaction's date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false) : IRequest<TransactionDto>;
