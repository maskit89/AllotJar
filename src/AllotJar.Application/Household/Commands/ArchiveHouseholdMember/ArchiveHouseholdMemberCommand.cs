using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.ArchiveHouseholdMember;

/// <summary>
/// Archives (or restores) a household member — soft, so history is kept. Archiving stops their
/// pocket money from next month on (rule 54); <paramref name="CancelCurrentMonthPocketMoney"/>
/// also cuts this month's remaining planned amount, otherwise it is kept. Returns the member.
/// </summary>
public record ArchiveHouseholdMemberCommand(
    Guid Id,
    bool Archived = true,
    bool CancelCurrentMonthPocketMoney = false) : IRequest<HouseholdMemberDto>;
