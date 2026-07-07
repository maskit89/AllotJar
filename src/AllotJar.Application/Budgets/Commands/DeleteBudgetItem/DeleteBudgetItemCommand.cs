using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.DeleteBudgetItem;

/// <summary>
/// Removes a single budget line (e.g. an income source the user no longer has).
/// Returns the whole recomputed month so the caller immediately sees the new
/// "Remaining to Budget" pool.
/// </summary>
public record DeleteBudgetItemCommand(Guid BudgetItemId) : IRequest<BudgetMonthDto>;
