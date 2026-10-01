using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Queries.GetMemberships;

public class GetMembershipsQueryHandler
    : IRequestHandler<GetMembershipsQuery, IReadOnlyList<MembershipDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService _identity;

    public GetMembershipsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser, IIdentityService identity)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<IReadOnlyList<MembershipDto>> Handle(
        GetMembershipsQuery request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var currentUserId = _currentUser.UserId;

        var memberships = await _db.HouseholdMemberships
            .AsNoTracking()
            .Where(m => m.OwnerId == ownerId)
            .OrderBy(m => m.Role)
                .ThenBy(m => m.CreatedUtc)
            .ToListAsync(cancellationToken);

        var result = memberships.Select(m => m.ToDto(currentUserId)).ToList();
        if (_currentUser.Role != HouseholdRole.Owner)
        {
            return result;
        }

        // The owner's "Send again" is for a login still waiting to choose its password (S-P2-3).
        for (var i = 0; i < memberships.Count; i++)
        {
            if (memberships[i] is { UserId: string userId, Status: MembershipStatus.Active }
                && userId != currentUserId
                && await _identity.FindByIdAsync(userId) is { MustChangePassword: true })
            {
                result[i] = result[i] with { AwaitingPassword = true };
            }
        }
        return result;
    }
}
