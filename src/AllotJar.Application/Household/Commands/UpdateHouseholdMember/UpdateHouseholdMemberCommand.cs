using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.UpdateHouseholdMember;

/// <summary>Edits a household member. Returns the updated member.</summary>
public record UpdateHouseholdMemberCommand(
    Guid Id,
    string Name,
    decimal NetMonthlyIncome,
    Guid? PersonalSavingsAccountId,
    // The version the edit form loaded (D11): a save of a record changed since is refused. Null is
    // no check, for a client loaded before the deploy that added versions.
    string? Version = null) : IRequest<HouseholdMemberDto>;
