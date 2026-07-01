using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;

/// <summary>Changes a membership's access level. The owner's role cannot be changed. Owner-only.</summary>
[OwnerOnly]
public record ChangeMemberRoleCommand(Guid MembershipId, HouseholdRole Role) : IRequest<MembershipDto>;
