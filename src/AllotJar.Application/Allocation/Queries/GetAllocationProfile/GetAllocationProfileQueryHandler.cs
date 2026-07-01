using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Allocation.Queries.GetAllocationProfile;

public class GetAllocationProfileQueryHandler : IRequestHandler<GetAllocationProfileQuery, AllocationProfileDto?>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetAllocationProfileQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AllocationProfileDto?> Handle(GetAllocationProfileQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var profile = await _db.AllocationProfiles
            .AsNoTracking()
            .Include(p => p.Rules)
            .Where(p => p.OwnerId == userId)
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(cancellationToken);

        return profile?.ToDto();
    }
}
