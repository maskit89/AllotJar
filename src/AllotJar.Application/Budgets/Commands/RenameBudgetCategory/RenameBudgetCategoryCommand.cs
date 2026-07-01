using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.RenameBudgetCategory;

/// <summary>Renames a category group. Returns the recomputed month.</summary>
public record RenameBudgetCategoryCommand(
    Guid CategoryId,
    string Name) : IRequest<BudgetMonthDto>;
