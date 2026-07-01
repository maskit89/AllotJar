using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Household.Queries.GetMemberSpending;

public class GetMemberSpendingQueryHandler
    : IRequestHandler<GetMemberSpendingQuery, IReadOnlyList<MemberSpendingDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMemberSpendingQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<MemberSpendingDto>> Handle(
        GetMemberSpendingQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var members = await _db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == userId && !m.IsArchived)
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(cancellationToken);

        if (members.Count == 0)
        {
            return Array.Empty<MemberSpendingDto>();
        }

        var memberIds = members.Select(m => m.Id).ToHashSet();

        // Load expense transactions (with their slices) and attribute in memory so
        // a split is counted by its per-member slices and a whole transaction by its
        // own member — never both (a split has no whole-transaction attribution).
        var expenses = await _db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == userId && t.Type == TransactionType.Expense)
            .ToListAsync(cancellationToken);

        var spentByMember = new Dictionary<Guid, decimal>();
        foreach (var t in expenses)
        {
            if (t.Splits.Count > 0)
            {
                foreach (var slice in t.Splits)
                {
                    if (slice.MemberId is Guid sliceMember && memberIds.Contains(sliceMember))
                    {
                        spentByMember[sliceMember] = spentByMember.GetValueOrDefault(sliceMember) + slice.Amount;
                    }
                }
            }
            else if (t.MemberId is Guid wholeMember && memberIds.Contains(wholeMember))
            {
                spentByMember[wholeMember] = spentByMember.GetValueOrDefault(wholeMember) + t.Amount;
            }
        }

        return members
            .Select(m => new MemberSpendingDto
            {
                MemberId = m.Id,
                Name = m.Name,
                Spent = spentByMember.GetValueOrDefault(m.Id),
            })
            .ToList();
    }
}
