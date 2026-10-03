using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.SplitTransaction;

/// <summary>
/// Splits one transaction across two or more budget lines. The slice amounts
/// must sum to the transaction's total, and each target line must match the
/// transaction's direction (an expense splits across expense lines, income
/// across income lines). The whole-transaction assignment is replaced by the
/// slices, each of which counts toward its target line's Spent. For an expense on a
/// jar-backed account, slices on a jar's line draw from that jar and the other slices from
/// <paramref name="PaidFromJarId"/>, or unallocated when null (rule 79).
/// </summary>
[AllowLimited]
public record SplitTransactionCommand(
    Guid TransactionId,
    IReadOnlyList<SplitAllocationInput> Allocations,
    // Set only after the user confirms budgeting a slice to a line in a different month than the
    // transaction's date (see TransactionInvariants.CrossMonthKey).
    bool AcknowledgeCrossMonth = false,
    Guid? PaidFromJarId = null,
    // The version the split editor loaded (D11, #308 review P2-1): a split saved over someone
    // else's change to the transaction is refused. Null is no check, for a client loaded before
    // the deploy that added versions.
    string? Version = null) : IRequest<TransactionDto>;

/// <summary>One requested slice: an amount attributed to a budget line and, optionally, a household member.</summary>
public record SplitAllocationInput(Guid BudgetItemId, decimal Amount, Guid? MemberId = null);
