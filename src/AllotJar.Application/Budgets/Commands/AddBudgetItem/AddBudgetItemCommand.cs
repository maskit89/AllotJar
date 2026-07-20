using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.AddBudgetItem;

/// <summary>
/// Adds a new line to a category (an income source when the category is the
/// Income group, otherwise a spending line). <c>MemberId</c> attributes an income
/// line to the household member who earns it (income-kind categories only).
/// Returns the whole recomputed month so the caller immediately sees the new
/// "Remaining to Budget" pool — and can reconcile the optimistic temp row against
/// the server-assigned id.
/// </summary>
public record AddBudgetItemCommand(
    Guid CategoryId,
    string Name,
    decimal PlannedAmount = 0m,
    Guid? MemberId = null) : IRequest<BudgetMonthDto>;
