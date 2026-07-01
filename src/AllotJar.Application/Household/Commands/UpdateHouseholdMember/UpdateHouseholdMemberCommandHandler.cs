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

        member.Name = request.Name.Trim();
        member.NetMonthlyIncome = request.NetMonthlyIncome;
        member.PersonalSavingsAccountId = request.PersonalSavingsAccountId;

        await _db.SaveChangesAsync(cancellationToken);

        var totalActiveNet = await _db.HouseholdMembers
            .Where(m => m.OwnerId == userId && !m.IsArchived)
            .SumAsync(m => m.NetMonthlyIncome, cancellationToken);

        return member.ToDto(totalActiveNet);
    }
}
