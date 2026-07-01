using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.ArchiveHouseholdMember;

/// <summary>Archives (or restores) a household member — soft, so history is kept. Returns the member.</summary>
public record ArchiveHouseholdMemberCommand(Guid Id, bool Archived = true) : IRequest<HouseholdMemberDto>;
