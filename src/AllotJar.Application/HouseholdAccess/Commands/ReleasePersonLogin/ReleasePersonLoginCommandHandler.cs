using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.HouseholdAccess.Commands.ReleasePersonLogin;

public class ReleasePersonLoginCommandHandler : IRequestHandler<ReleasePersonLoginCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ReleasePersonLoginCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(ReleasePersonLoginCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var userId = _currentUser.UserId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var person = await _db.HouseholdMembers
            .FirstOrDefaultAsync(m => m.Id == request.MemberId && m.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Person {request.MemberId} was not found.");

        var linkedNow = await _db.HouseholdMemberships.AnyAsync(
            m => m.OwnerId == ownerId && m.UserId == userId && m.MemberId == person.Id, cancellationToken);
        if (linkedNow)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["MemberId"] = new[] { $"Your login is linked to {person.Name} now. Ask the owner to link it to the right person first." }
            });
        }

        // Only the caller's own row: the user id comes from the session, never from the request.
        var row = await _db.PersonLogins.FirstOrDefaultAsync(
            p => p.HouseholdMemberId == person.Id && p.UserId == userId && p.ReleasedUtc == null, cancellationToken)
            ?? throw new NotFoundException($"Your login isn't on record as {person.Name}'s.");
        row.ReleasedUtc = DateTime.UtcNow;
        await _db.SaveChangesAsync(cancellationToken);
    }
}
