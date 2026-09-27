using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetMemberSpending;

/// <summary>
/// Per-member attributed spending — the "who owes what" lens the workbook keeps by hand (the
/// Visa Liz/Alex/Marisa columns) — in the budget's base currency. With <paramref name="Year"/>
/// and <paramref name="Month"/> it covers that month only (the People page, which shows the
/// same month as the Budget, rule 29); without them, all time. Owner-scoped; active members only.
/// </summary>
public record GetMemberSpendingQuery(int? Year = null, int? Month = null) : IRequest<IReadOnlyList<MemberSpendingDto>>;
