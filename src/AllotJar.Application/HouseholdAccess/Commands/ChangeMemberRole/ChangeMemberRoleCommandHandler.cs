using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;

public class ChangeMemberRoleCommandHandler : IRequestHandler<ChangeMemberRoleCommand, MembershipDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ChangeMemberRoleCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MembershipDto> Handle(ChangeMemberRoleCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.Id == request.MembershipId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Membership {request.MembershipId} was not found.");

        if (membership.Role == HouseholdRole.Owner)
        {
            throw new ForbiddenAccessException("The owner's role cannot be changed.");
        }

        membership.Role = request.Role;
        await _db.SaveChangesAsync(cancellationToken);

        return membership.ToDto(_currentUser.UserId);
    }
}
