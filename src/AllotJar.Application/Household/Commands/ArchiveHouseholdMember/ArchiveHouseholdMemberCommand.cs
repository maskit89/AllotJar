using MediatR;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.ArchiveHouseholdMember;

/// <summary>
/// Archives (or restores) a household member — soft, so history is kept. Archiving also stops
/// the person's pocket-money planned allocations from next month onward, in every future budget
/// already created (rule 54); for the current month the caller must say whether to keep or
/// cancel the remaining planned amount when there is one (<see cref="PocketMoneyThisMonth"/>),
/// otherwise the archive is refused with that question. Cancelling never touches recorded
/// payments or balances. Restoring recreates nothing — the next pocket-money sync does. Returns
/// the member.
/// </summary>
public record ArchiveHouseholdMemberCommand(
    Guid Id,
    bool Archived = true,
    PocketMoneyDecision? PocketMoneyThisMonth = null) : IRequest<HouseholdMemberDto>;

/// <summary>What to do with the archived person's remaining pocket money in the current month (rule 54).</summary>
public enum PocketMoneyDecision
{
    /// <summary>Leave this month's planned amount as it is; the stop starts next month.</summary>
    Keep = 0,

    /// <summary>Cancel what is still planned this month; payments already recorded are kept.</summary>
    Cancel = 1,
}
