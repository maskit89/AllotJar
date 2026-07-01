using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;

public class UpsertAllocationProfileCommandHandler
    : IRequestHandler<UpsertAllocationProfileCommand, AllocationProfileDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpsertAllocationProfileCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AllocationProfileDto> Handle(
        UpsertAllocationProfileCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        AllocationProfile profile;
        if (request.Id is Guid id)
        {
            profile = await _db.AllocationProfiles
                .Include(p => p.Rules)
                .FirstOrDefaultAsync(p => p.Id == id, cancellationToken)
                ?? throw new NotFoundException($"Allocation profile {id} was not found.");

            if (profile.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }

            profile.Name = request.Name.Trim();
            profile.SourceAccountId = request.SourceAccountId;
            profile.BalanceLeanPercent = request.BalanceLeanPercent;
            // Rules are replaced wholesale.
            _db.AllocationRules.RemoveRange(profile.Rules);
            profile.Rules.Clear();
        }
        else
        {
            profile = new AllocationProfile
            {
                OwnerId = userId,
                Name = request.Name.Trim(),
                SourceAccountId = request.SourceAccountId,
                BalanceLeanPercent = request.BalanceLeanPercent,
            };
            _db.AllocationProfiles.Add(profile);
        }

        // Add rules with scalar foreign keys (the nav-graph add throws on EF InMemory).
        foreach (var spec in request.Rules.OrderBy(r => r.Order))
        {
            _db.AllocationRules.Add(new AllocationRule
            {
                AllocationProfileId = profile.Id,
                Order = spec.Order,
                Type = spec.Type,
                Split = spec.Split,
                FixedAmountPerMember = spec.FixedAmountPerMember,
            });
        }

        await _db.SaveChangesAsync(cancellationToken);

        var saved = await _db.AllocationProfiles
            .AsNoTracking()
            .Include(p => p.Rules)
            .FirstAsync(p => p.Id == profile.Id, cancellationToken);

        return saved.ToDto();
    }
}
