using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.UpdateBudgetItem;

/// <summary>
/// Sets the planned amount (and optionally the name) of a single budget line.
/// Returns the whole recomputed month so the caller immediately sees the new
/// "Remaining to Budget" pool without a second round-trip.
/// </summary>
public record UpdateBudgetItemCommand(
    Guid BudgetItemId,
    decimal PlannedAmount,
    string? Name = null,
    // The version the edit form loaded (D11): a save of a record changed since is refused. Null is
    // no check, for a client loaded before the deploy that added versions.
    string? Version = null) : IRequest<BudgetMonthDto>;
