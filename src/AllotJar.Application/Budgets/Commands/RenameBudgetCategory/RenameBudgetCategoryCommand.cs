using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.RenameBudgetCategory;

/// <summary>Renames a category group. Returns the recomputed month.</summary>
public record RenameBudgetCategoryCommand(
    Guid CategoryId,
    string Name,
    // The version the edit form loaded (D11): a save of a record changed since is refused. Null is
    // no check, for a client loaded before the deploy that added versions.
    string? Version = null) : IRequest<BudgetMonthDto>;
