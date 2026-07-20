using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetMemberIncome;

/// <summary>
/// Per-member income for a month, derived from the budget: planned = the month's income
/// lines attributed to each person; received = income transactions (whole + slices)
/// attributed to them, dated in the month. Plus the unattributed planned remainder.
/// </summary>
public record GetMemberIncomeQuery(int Year, int Month) : IRequest<MemberIncomeResultDto>;
