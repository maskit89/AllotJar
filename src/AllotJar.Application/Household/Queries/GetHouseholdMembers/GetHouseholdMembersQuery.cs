using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetHouseholdMembers;

/// <summary>Lists the household's members with each one's share of total net income.</summary>
public record GetHouseholdMembersQuery(bool IncludeArchived = false)
    : IRequest<IReadOnlyList<HouseholdMemberDto>>;
