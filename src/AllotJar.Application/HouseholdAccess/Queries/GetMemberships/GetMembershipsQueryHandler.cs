using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Dtos;

namespace AllotJar.Application.HouseholdAccess.Queries.GetMemberships;

public class GetMembershipsQueryHandler
    : IRequestHandler<GetMembershipsQuery, IReadOnlyList<MembershipDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMembershipsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
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

        return memberships.Select(m => m.ToDto(currentUserId)).ToList();
    }
}
