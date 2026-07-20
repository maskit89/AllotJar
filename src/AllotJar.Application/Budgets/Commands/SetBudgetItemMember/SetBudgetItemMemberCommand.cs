using MediatR;
using AllotJar.Application.Budgets.Dtos;

namespace AllotJar.Application.Budgets.Commands.SetBudgetItemMember;

/// <summary>
/// Attributes an income line to the household member who earns it (null clears the
/// attribution back to whole-household). A dedicated facet command like /bill and /paid —
/// deliberately NOT folded into UpdateBudgetItem, whose rename path omits the field and
/// would silently clear it. Returns the recomputed month.
/// </summary>
public record SetBudgetItemMemberCommand(Guid BudgetItemId, Guid? MemberId) : IRequest<BudgetMonthDto>;
