using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Household.Commands.CreateHouseholdMember;

public class CreateHouseholdMemberCommandHandler
    : IRequestHandler<CreateHouseholdMemberCommand, HouseholdMemberDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CreateHouseholdMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<HouseholdMemberDto> Handle(
        CreateHouseholdMemberCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // A personal-savings account (soft hint, no FK) must exist and belong to this household —
        // otherwise a stale/foreign id would later be booked as an allocation transfer into a
        // non-existent (crash) or another household's (leak) account.
        if (request.PersonalSavingsAccountId is Guid savingsId)
        {
            var owned = await _db.Accounts
                .AnyAsync(a => a.Id == savingsId && a.OwnerId == userId, cancellationToken);
            if (!owned)
            {
                throw new NotFoundException($"Account {savingsId} was not found.");
            }
        }

        var nextOrder = await _db.HouseholdMembers
            .Where(m => m.OwnerId == userId)
            .Select(m => (int?)m.DisplayOrder)
            .MaxAsync(cancellationToken) ?? -1;

        var member = new HouseholdMember
        {
            OwnerId = userId,
            Name = request.Name.Trim(),
            NetMonthlyIncome = request.NetMonthlyIncome,
            PersonalSavingsAccountId = request.PersonalSavingsAccountId,
            DisplayOrder = nextOrder + 1,
        };

        _db.HouseholdMembers.Add(member);
        await _db.SaveChangesAsync(cancellationToken);

        var totalActiveNet = await _db.HouseholdMembers
            .Where(m => m.OwnerId == userId && !m.IsArchived)
            .SumAsync(m => m.NetMonthlyIncome, cancellationToken);

        return member.ToDto(totalActiveNet);
    }
}
