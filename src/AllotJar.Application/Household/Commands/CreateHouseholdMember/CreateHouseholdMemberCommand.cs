using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.CreateHouseholdMember;

/// <summary>Adds a person to the household. Returns the new member.</summary>
public record CreateHouseholdMemberCommand(
    string Name,
    decimal NetMonthlyIncome,
    Guid? PersonalSavingsAccountId) : IRequest<HouseholdMemberDto>;
