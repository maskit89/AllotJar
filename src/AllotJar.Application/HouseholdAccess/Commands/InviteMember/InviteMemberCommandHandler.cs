using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.InviteMember;

public class InviteMemberCommandHandler : IRequestHandler<InviteMemberCommand, InviteResultDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService _identity;

    public InviteMemberCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService identity)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<InviteResultDto> Handle(InviteMemberCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var email = request.Email.Trim();

        var alreadyInHousehold = await _db.HouseholdMemberships
            .AnyAsync(m => m.OwnerId == ownerId && m.InvitedEmail == email, cancellationToken);
        if (alreadyInHousehold)
        {
            throw Conflict("Email", "That email already has access to this household.");
        }

        if (request.MemberId is Guid memberId)
        {
            var memberInHousehold = await _db.HouseholdMembers
                .AnyAsync(m => m.Id == memberId && m.OwnerId == ownerId, cancellationToken);
            if (!memberInHousehold)
            {
                throw new NotFoundException($"Member {memberId} was not found.");
            }

            // The budget person ↔ login link is 1:1 — refuse a person another login already claims.
            var alreadyLinked = await _db.HouseholdMemberships
                .AnyAsync(m => m.OwnerId == ownerId && m.MemberId == memberId, cancellationToken);
            if (alreadyLinked)
            {
                throw Conflict("MemberId", "That budget person is already linked to another login.");
            }
        }

        var membership = new HouseholdMembership
        {
            OwnerId = ownerId,
            Role = request.Role,
            InvitedEmail = email,
            DisplayName = request.DisplayName,
            MemberId = request.MemberId,
            CreatedUtc = DateTime.UtcNow,
        };

        string? rawToken = null;
        if (request.Method == InviteMethod.Direct)
        {
            if (await _identity.EmailExistsAsync(email))
            {
                // A temporary password only makes sense for someone without an account. Existing
                // accounts join via a link invite, which they accept while signed in.
                throw Conflict("Email", "That email already has an account — use ‘Generate an invite link’ so they can accept it.");
            }

            // P59 rests on only that login seeing its private accounts, and the owner knows this
            // password: the new login must choose its own before it can do anything (S-P2-3).
            var created = await _identity.CreateUserAsync(
                email, request.TempPassword!, request.DisplayName, mustChangePassword: true);
            if (!created.Succeeded)
            {
                throw Conflict("Password", created.Errors);
            }

            membership.UserId = created.UserId;
            membership.Status = MembershipStatus.Active;
            // Rule 32: a person who gains a login reviews who sees the accounts they already hold.
            membership.SharingReviewPending = request.MemberId is not null;
        }
        else
        {
            rawToken = InviteToken.Generate();
            membership.InviteTokenHash = InviteToken.Hash(rawToken);
            membership.InviteExpiresUtc = DateTime.UtcNow.AddDays(7);
            membership.Status = MembershipStatus.Invited;
        }

        _db.HouseholdMemberships.Add(membership);
        await _db.SaveChangesAsync(cancellationToken);

        return new InviteResultDto(membership.ToDto(_currentUser.UserId), rawToken);
    }

    private static ValidationException Conflict(string field, string message) =>
        new(new Dictionary<string, string[]> { [field] = new[] { message } });

    private static ValidationException Conflict(string field, IReadOnlyList<string> messages) =>
        new(new Dictionary<string, string[]> { [field] = messages.ToArray() });
}
