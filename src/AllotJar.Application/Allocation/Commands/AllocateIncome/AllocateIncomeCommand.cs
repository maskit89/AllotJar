using MediatR;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Security;
using AllotJar.Application.Jars;

namespace AllotJar.Application.Allocation.Commands.AllocateIncome;

/// <summary>
/// Records the month's allocation transfers — each member's surplus moved from the source
/// account into their personal savings — after the user confirms they have completed those
/// bank transfers (rules 7/29): the suggested amounts remain a plan until then.
/// <paramref name="DepartedOn"/> is the date the money left the source account; receipt stays
/// unconfirmed (in transit) until each transfer's receipt is confirmed on the register, unless
/// <paramref name="ReceivedOn"/> supplies the same-day or later arrival for all of them.
/// Re-running keeps an unchanged member transfer (and any receipt already confirmed on it),
/// re-records one whose amount changed, and refuses to discard a transfer whose receipt is
/// already confirmed. <paramref name="JarAllocations"/> answers the incoming-money prompt for
/// each member whose savings account backs jars (rule 78): how much of that member's transfer
/// goes to which jar, the rest unallocated; it applies once the receipt is posted. Returns the
/// computed result with the number of transfers created.
/// </summary>
[AllowLimited]
public record AllocateIncomeCommand(
    int Year,
    int Month,
    Guid? ProfileId = null,
    DateOnly? DepartedOn = null,
    DateOnly? ReceivedOn = null,
    bool ConfirmedCompleted = false,
    IReadOnlyList<AllocateIncomeJarAllocation>? JarAllocations = null)
    : IRequest<AllocationResultDto>;

/// <summary>Part of one member's allocation transfer put into a jar of their savings account.</summary>
public record AllocateIncomeJarAllocation(Guid MemberId, Guid JarId, decimal Amount);
