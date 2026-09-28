using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.DeleteBudgetItem;

/// <summary>
/// Removes a single budget line (e.g. an income source the user no longer has).
/// A jar's Savings line is refused (rule 60): its contribution is skipped for the month
/// (<c>SkipJarContribution</c>) or the jar is archived, never silently removed. Returns
/// the whole recomputed month so the caller immediately sees the new "Remaining to
/// Budget" pool.
/// </summary>
public record DeleteBudgetItemCommand(Guid BudgetItemId) : IRequest<BudgetMonthDto>;
