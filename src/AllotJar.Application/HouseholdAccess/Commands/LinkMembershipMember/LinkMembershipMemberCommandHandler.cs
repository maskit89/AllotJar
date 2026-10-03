using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;

public class LinkMembershipMemberCommandHandler
    : IRequestHandler<LinkMembershipMemberCommand, MembershipDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public LinkMembershipMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MembershipDto> Handle(
        LinkMembershipMemberCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.Id == request.MembershipId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Membership {request.MembershipId} was not found.");

        if (request.MemberId is Guid memberId)
        {
            var memberInHousehold = await _db.HouseholdMembers
                .AnyAsync(m => m.Id == memberId && m.OwnerId == ownerId, cancellationToken);
            if (!memberInHousehold)
            {
                throw new NotFoundException($"Member {memberId} was not found.");
            }

            // The link is 1:1 — refuse a person another login already claims (ignoring this one).
            var claimedByAnother = await _db.HouseholdMemberships
                .AnyAsync(
                    m => m.OwnerId == ownerId && m.MemberId == memberId && m.Id != membership.Id,
                    cancellationToken);
            if (claimedByAnother)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["MemberId"] = new[] { "That budget person is already linked to another login." }
                });
            }
        }

        // Rule 32 (P58): a login newly linked to a person reviews who sees the accounts that person
        // already holds; their visibility stays as it is until then. Privacy stays with the login
        // that chose it (P59), so linking another login to the person — the owner's own included —
        // never reveals or hands over a private account.
        if (request.MemberId is not null && request.MemberId != membership.MemberId && membership.UserId is not null)
        {
            membership.SharingReviewPending = true;
        }
        // S-P3-8 (D5): every login ever linked to a person stays on record until that login itself
        // releases it, so a login linked to the person later can't make its accounts private while
        // an earlier one is still in the household, whichever order the links were made in.
        if (request.MemberId != membership.MemberId && membership.Status == MembershipStatus.Active)
        {
            await PersonLoginRecords.RecordUnlinkAsync(_db, membership.MemberId, membership.UserId, cancellationToken);
            await PersonLoginRecords.RecordLinkAsync(_db, request.MemberId, membership.UserId, cancellationToken);
        }
        membership.MemberId = request.MemberId;
        await _db.SaveChangesAsync(cancellationToken);

        return membership.ToDto(_currentUser.UserId);
    }
}
