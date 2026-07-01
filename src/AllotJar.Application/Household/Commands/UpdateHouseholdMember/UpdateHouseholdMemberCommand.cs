using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.UpdateHouseholdMember;

/// <summary>Edits a household member. Returns the updated member.</summary>
public record UpdateHouseholdMemberCommand(
    Guid Id,
    string Name,
    decimal NetMonthlyIncome,
    Guid? PersonalSavingsAccountId) : IRequest<HouseholdMemberDto>;
