using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Allocation;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetHouseholdMembers;

public class GetHouseholdMembersQueryHandler
    : IRequestHandler<GetHouseholdMembersQuery, IReadOnlyList<HouseholdMemberDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetHouseholdMembersQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<HouseholdMemberDto>> Handle(
        GetHouseholdMembersQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var members = await _db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == userId && (request.IncludeArchived || !m.IsArchived))
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(cancellationToken);

        // Income and share come from the selected month's budget (rule 28); archived members
        // hold no income and get a 0 share.
        var (year, month) = HouseholdMonth.Resolve(request.Year, request.Month);
        var shares = await MemberIncome.SharesAsync(_db, userId, year, month, members, cancellationToken);
        // Pocket money is always read for the calendar current month: it is what archiving asks
        // about (rule 54), not a figure of the selected month.
        var pocketMoney = await PocketMoneyLines.ForCurrentMonthAsync(_db, userId, cancellationToken);

        return members.Select(m => m.ToDto(shares, year, month, pocketMoney)).ToList();
    }
}
