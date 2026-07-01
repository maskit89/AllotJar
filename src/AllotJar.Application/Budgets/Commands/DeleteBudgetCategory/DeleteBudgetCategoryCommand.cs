using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.DeleteBudgetCategory;

/// <summary>
/// Deletes a category group and all of its lines (cascade). The Income group
/// cannot be deleted. Returns the recomputed month.
/// </summary>
public record DeleteBudgetCategoryCommand(Guid CategoryId) : IRequest<BudgetMonthDto>;
