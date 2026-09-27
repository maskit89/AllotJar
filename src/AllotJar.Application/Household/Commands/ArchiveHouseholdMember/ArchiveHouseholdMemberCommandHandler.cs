using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.ArchiveHouseholdMember;

public class ArchiveHouseholdMemberCommandHandler
    : IRequestHandler<ArchiveHouseholdMemberCommand, HouseholdMemberDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ArchiveHouseholdMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<HouseholdMemberDto> Handle(
        ArchiveHouseholdMemberCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var member = await _db.HouseholdMembers
            .FirstOrDefaultAsync(m => m.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Household member {request.Id} was not found.");

        if (member.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        member.IsArchived = request.Archived;
        if (request.Archived)
        {
            // Rule 54: planned pocket money stops from next month (future budgets included); the
            // current month keeps or cancels its remainder as the user chose; payments already
            // recorded stay exactly where they are.
            await PocketMoneyLines.StopFromNextMonthAsync(
                _db, userId, member.Id, request.CancelCurrentMonthPocketMoney, cancellationToken);
        }
        await _db.SaveChangesAsync(cancellationToken);

        return await HouseholdMemberReads.ToDtoAsync(_db, userId, member, cancellationToken);
    }
}
