using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.ReorderBudgetCategories;

/// <summary>
/// Sets the display order of a month's category groups to match the given id
/// order. (The Income group always renders first regardless.) Returns the
/// recomputed month.
/// </summary>
public record ReorderBudgetCategoriesCommand(
    Guid BudgetMonthId,
    IReadOnlyList<Guid> OrderedCategoryIds) : IRequest<BudgetMonthDto>;
