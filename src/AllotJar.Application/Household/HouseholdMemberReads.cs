using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Allocation;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Household;

/// <summary>The member DTO as the People page reads it for the current month (rule 28 income and share).</summary>
public static class HouseholdMemberReads
{
    public static async Task<HouseholdMemberDto> ToDtoAsync(
        IApplicationDbContext db, ICurrentUser viewer, string ownerId, HouseholdMember member, CancellationToken cancellationToken)
    {
        var (year, month) = HouseholdMonth.Resolve(null, null);
        var members = await db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == ownerId)
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(cancellationToken);
        var shares = await MemberIncome.SharesAsync(db, ownerId, year, month, members, cancellationToken);
        var hidden = await HiddenAccounts.AmongAsync(db, viewer.UserId, new[] { member.PersonalSavingsAccountId }, cancellationToken);
        var dto = member.ToDto(shares, year, month, hidden);
        dto.CanReleaseMyLink = (await PersonLoginRecords.ReleasableAsync(db, ownerId, viewer.UserId, cancellationToken)).Contains(member.Id);
        return dto;
    }
}
