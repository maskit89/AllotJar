using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.SetBudgetItemBill;

/// <summary>
/// Marks a line as a bill due on <paramref name="DueDay"/> (1–31), or clears the
/// bill when <paramref name="DueDay"/> is null. Clearing also resets the paid
/// status. Returns the recomputed month.
/// </summary>
public record SetBudgetItemBillCommand(
    Guid BudgetItemId,
    int? DueDay) : IRequest<BudgetMonthDto>;
