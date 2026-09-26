using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.AssignTransaction;

/// <summary>
/// Assigns a transaction to a budget line (or clears the assignment when
/// <paramref name="BudgetItemId"/> is null). The line's actual spending then
/// reflects this transaction on the next budget read. For an expense on a jar-backed account
/// assigned to a line that is not a jar, <paramref name="PaidFromJarId"/> answers "which jar
/// does this come from?" (rule 79; unallocated when null).
/// </summary>
[AllowLimited]
public record AssignTransactionCommand(
    Guid TransactionId,
    Guid? BudgetItemId,
    // Set only after the user confirms budgeting a transaction to a line in a different month
    // than its date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false,
    Guid? PaidFromJarId = null)
    : IRequest<TransactionDto>;
