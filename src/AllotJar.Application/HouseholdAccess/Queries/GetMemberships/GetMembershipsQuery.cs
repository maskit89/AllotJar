using MediatR;
using AllotJar.Application.HouseholdAccess.Dtos;

namespace AllotJar.Application.HouseholdAccess.Queries.GetMemberships;

/// <summary>Lists the logins that have access to the caller's household.</summary>
public record GetMembershipsQuery : IRequest<IReadOnlyList<MembershipDto>>;
