using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Commands.UpdateHouseholdMember;

public class UpdateHouseholdMemberCommandHandler
    : IRequestHandler<UpdateHouseholdMemberCommand, HouseholdMemberDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateHouseholdMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<HouseholdMemberDto> Handle(
        UpdateHouseholdMemberCommand request, CancellationToken cancellationToken)
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

        // A personal-savings account must exist and belong to this household. It's a soft hint with
        // no FK, so validate here — otherwise a stale or foreign id would be stored and later booked
        // as an allocation transfer into a non-existent (crash) or another household's (leak) account.
        if (request.PersonalSavingsAccountId is Guid savingsId)
        {
            var owned = await _db.Accounts
                .AnyAsync(a => a.Id == savingsId && a.OwnerId == userId, cancellationToken);
            if (!owned)
            {
                throw new NotFoundException($"Account {savingsId} was not found.");
            }
            await HouseholdMemberGuards.EnsureNotAnAllocationSourceAsync(
                _db, userId, savingsId, cancellationToken);
        }

        member.Name = request.Name.Trim();
        member.NetMonthlyIncome = request.NetMonthlyIncome;
        member.PersonalSavingsAccountId = request.PersonalSavingsAccountId;

        await _db.SaveChangesAsync(cancellationToken);

        return await HouseholdMemberReads.ToDtoAsync(_db, userId, member, cancellationToken);
    }
}
