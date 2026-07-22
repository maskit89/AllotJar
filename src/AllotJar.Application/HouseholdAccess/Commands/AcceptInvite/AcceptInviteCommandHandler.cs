using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;

public class AcceptInviteCommandHandler : IRequestHandler<AcceptInviteCommand, AcceptInviteResult>
{
    private readonly IApplicationDbContext _db;
    private readonly IIdentityService _identity;
    private readonly ICurrentUser _currentUser;

    public AcceptInviteCommandHandler(IApplicationDbContext db, IIdentityService identity, ICurrentUser currentUser)
    {
        _db = db;
        _identity = identity;
        _currentUser = currentUser;
    }

    public async Task<AcceptInviteResult> Handle(AcceptInviteCommand request, CancellationToken cancellationToken)
    {
        var hash = InviteToken.Hash(request.Token);

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(
                m => m.InviteTokenHash == hash && m.Status == MembershipStatus.Invited,
                cancellationToken)
            ?? throw new NotFoundException("This invite link is invalid or has already been used.");

        if (membership.InviteExpiresUtc is null || membership.InviteExpiresUtc < DateTime.UtcNow)
        {
            throw new ForbiddenAccessException("This invite link has expired.");
        }

        // Path A — a signed-in user joins this household with their existing login (keeping their own
        // budget). They can only accept an invite addressed to their own email.
        if (_currentUser.UserId is string userId)
        {
            var me = await _identity.FindByIdAsync(userId)
                ?? throw new ForbiddenAccessException("No authenticated user on the request.");

            if (!string.Equals(me.Email, membership.InvitedEmail, StringComparison.OrdinalIgnoreCase))
            {
                throw Invalid("Email", "This invite was sent to a different email address.");
            }

            var already = await _db.HouseholdMemberships.AnyAsync(
                m => m.OwnerId == membership.OwnerId && m.UserId == userId && m.Id != membership.Id,
                cancellationToken);
            if (already)
            {
                throw Invalid("Email", "You already have access to this household.");
            }

            membership.UserId = userId;
            var joinedName = me.DisplayName ?? request.DisplayName;
            Activate(membership, joinedName);
            await _db.SaveChangesAsync(cancellationToken);

            // Land the accepter in the household they just joined — otherwise the app resolves
            // back to their own budget and the join looks like it did nothing.
            await _identity.SetActiveHouseholdAsync(userId, membership.OwnerId);
            return new AcceptInviteResult(userId, me.Email, membership.Role, joinedName);
        }

        // Path B — anonymous accept. An existing account must sign in first (then accept as Path A).
        if (await _identity.EmailExistsAsync(membership.InvitedEmail))
        {
            throw Invalid("Email", "You already have an account — sign in first, then open this link to join.");
        }

        if (string.IsNullOrWhiteSpace(request.Password) || request.Password.Length < 8)
        {
            throw Invalid("Password", "Choose a password of at least 8 characters.");
        }

        // A new login is being created for the invitee, so they must accept the terms themselves —
        // registration requires the same. (A signed-in accepter consented when they registered.)
        if (!request.AcceptedTerms)
        {
            throw Invalid("AcceptedTerms", "Please accept the terms and privacy policy to create your login.");
        }

        var displayName = request.DisplayName ?? membership.DisplayName;
        var created = await _identity.CreateUserAsync(
            membership.InvitedEmail, request.Password, displayName, consented: true);
        if (!created.Succeeded)
        {
            throw new ValidationException(new Dictionary<string, string[]> { ["Password"] = created.Errors.ToArray() });
        }

        membership.UserId = created.UserId;
        Activate(membership, displayName);
        await _db.SaveChangesAsync(cancellationToken);

        // Their only household is the one they just joined; make that explicit so it stays their
        // landing household even if they later start a budget of their own.
        await _identity.SetActiveHouseholdAsync(created.UserId!, membership.OwnerId);
        return new AcceptInviteResult(
            created.UserId!, membership.InvitedEmail, membership.Role, displayName, CreatedNewLogin: true);
    }

    private static void Activate(HouseholdMembership membership, string? displayName)
    {
        membership.Status = MembershipStatus.Active;
        membership.InviteTokenHash = null;
        membership.InviteExpiresUtc = null;
        if (!string.IsNullOrWhiteSpace(displayName))
        {
            membership.DisplayName = displayName;
        }
    }

    private static ValidationException Invalid(string field, string message) =>
        new(new Dictionary<string, string[]> { [field] = new[] { message } });
}
