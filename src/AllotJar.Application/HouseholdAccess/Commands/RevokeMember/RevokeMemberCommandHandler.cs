using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.RevokeMember;

public class RevokeMemberCommandHandler : IRequestHandler<RevokeMemberCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public RevokeMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(RevokeMemberCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.Id == request.MembershipId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Membership {request.MembershipId} was not found.");

        if (membership.Role == HouseholdRole.Owner)
        {
            throw new ForbiddenAccessException("The owner cannot be removed from the household.");
        }

        // S-P3-8: a login given access again is still its person's own (P59 keeps its privacy too).
        await PersonLogin.RecordUnlinkAsync(_db, ownerId, membership.MemberId, membership.UserId, cancellationToken);
        _db.HouseholdMemberships.Remove(membership);
        await _db.SaveChangesAsync(cancellationToken);
    }
}
