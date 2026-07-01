using MediatR;
using AllotJar.Application.Common.Security;
using AllotJar.Application.HouseholdAccess.Dtos;

namespace AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;

/// <summary>
/// Links a login (membership) to the budget person it represents in the household, or unlinks it
/// (a null <see cref="MemberId"/>). The person↔login link is 1:1 within a household. Owner-only.
/// </summary>
[OwnerOnly]
public record LinkMembershipMemberCommand(Guid MembershipId, Guid? MemberId) : IRequest<MembershipDto>;
