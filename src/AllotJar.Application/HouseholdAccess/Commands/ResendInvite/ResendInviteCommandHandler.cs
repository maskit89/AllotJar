using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.ResendInvite;

public class ResendInviteCommandHandler : IRequestHandler<ResendInviteCommand, ResendInviteResult>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService _identity;

    public ResendInviteCommandHandler(IApplicationDbContext db, ICurrentUser currentUser, IIdentityService identity)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<ResendInviteResult> Handle(ResendInviteCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.Id == request.MembershipId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Membership {request.MembershipId} was not found.");

        // A pending link invite gets a new link: only the old one's hash is kept, so it can't be
        // sent again as it was. Nothing is saved yet: the new link replaces the old one only once
        // its email went out (CommitResentInviteCommand), so a failed send leaves the old link working.
        if (membership.Status == MembershipStatus.Invited && membership.UserId is null)
        {
            return new ResendInviteResult(membership.InvitedEmail, InviteToken.Generate());
        }

        // A login someone else created, still on its temporary password: its "choose your
        // password" link goes to its own address again (S-P2-3).
        if (membership.UserId is string userId
            && await _identity.FindByIdAsync(userId) is { MustChangePassword: true } login)
        {
            return new ResendInviteResult(login.Email, null);
        }

        throw new ValidationException(new Dictionary<string, string[]>
        {
            ["MembershipId"] = new[] { "There's nothing to send again: they've already joined and chosen their password." },
        });
    }
}
