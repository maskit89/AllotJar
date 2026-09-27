using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetHouseholdMembers;

/// <summary>
/// Lists the household's members with each one's income and share in the selected month's
/// budget (rule 28). <paramref name="Year"/>/<paramref name="Month"/> default to the current
/// UTC month.
/// </summary>
public record GetHouseholdMembersQuery(bool IncludeArchived = false, int? Year = null, int? Month = null)
    : IRequest<IReadOnlyList<HouseholdMemberDto>>;
