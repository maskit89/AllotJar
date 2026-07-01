using MediatR;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Budgets.Commands.AddBudgetCategory;

/// <summary>
/// Creates a new high-level group in a month — an expense group (e.g. "Housing",
/// "Subscriptions") or a <see cref="CategoryKind.Savings"/> group of sinking funds.
/// Income groups are not created this way — a budget has the single Income group
/// seeded with it. Returns the recomputed month.
/// </summary>
public record AddBudgetCategoryCommand(
    Guid BudgetMonthId,
    string Name,
    CategoryKind Kind = CategoryKind.Expense) : IRequest<BudgetMonthDto>;
