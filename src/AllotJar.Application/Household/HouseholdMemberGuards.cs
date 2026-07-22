using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Household;

/// <summary>
/// Shared write-time guards for household members. A member's personal savings account can
/// never be an allocation profile's SOURCE account: committing that allocation would book a
/// no-op self-transfer (both legs on one account — zero balance effect, still counted and
/// reported as a created transfer). The allocation-profile editor enforces the mirror rule,
/// and AllocateIncome rejects the combination at commit as the last line of defence.
/// </summary>
public static class HouseholdMemberGuards
{
    public static async Task EnsureNotAnAllocationSourceAsync(
        IApplicationDbContext db, string ownerId, Guid savingsAccountId, CancellationToken cancellationToken)
    {
        var clashingProfile = await db.AllocationProfiles
            .Where(p => p.OwnerId == ownerId && p.SourceAccountId == savingsAccountId)
            .Select(p => p.Name)
            .FirstOrDefaultAsync(cancellationToken);
        if (clashingProfile is not null)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["PersonalSavingsAccountId"] = new[]
                {
                    $"That account is the source account of the '{clashingProfile}' allocation profile — " +
                    "allocating would transfer this member's share to itself. Choose a different savings account.",
                },
            });
        }
    }
}
