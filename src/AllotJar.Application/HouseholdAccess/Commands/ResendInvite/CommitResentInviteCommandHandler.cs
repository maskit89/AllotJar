using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.ResendInvite;

public class CommitResentInviteCommandHandler : IRequestHandler<CommitResentInviteCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CommitResentInviteCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(CommitResentInviteCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.Id == request.MembershipId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Membership {request.MembershipId} was not found.");

        // Accepted in the meantime: there is no link left to replace.
        if (membership.Status != MembershipStatus.Invited || membership.UserId is not null)
        {
            return;
        }
        membership.InviteTokenHash = InviteToken.Hash(request.InviteToken);
        membership.InviteExpiresUtc = DateTime.UtcNow.AddDays(7);
        await _db.SaveChangesAsync(cancellationToken);
    }
}
