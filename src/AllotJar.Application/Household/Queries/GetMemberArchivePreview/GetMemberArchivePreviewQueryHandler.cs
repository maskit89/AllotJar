using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;

namespace AllotJar.Application.Household.Queries.GetMemberArchivePreview;

public class GetMemberArchivePreviewQueryHandler
    : IRequestHandler<GetMemberArchivePreviewQuery, MemberArchivePreviewDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMemberArchivePreviewQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MemberArchivePreviewDto> Handle(
        GetMemberArchivePreviewQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var member = await _db.HouseholdMembers
            .AsNoTracking()
            .FirstOrDefaultAsync(m => m.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Household member {request.Id} was not found.");

        if (member.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var (year, monthNo) = HouseholdMonth.Resolve(null, null);
        var months = await PocketMoneyLines.ReadFromAsync(_db, userId, member.Id, year, monthNo, cancellationToken);

        static PocketMoneyMonthDto ToDto(PocketMoneyMonth m) => new()
        {
            Year = m.Year,
            Month = m.Month,
            Planned = m.Planned,
            Paid = m.Paid,
            Remaining = m.Remaining,
        };

        return new MemberArchivePreviewDto
        {
            Id = member.Id,
            Name = member.Name,
            IsArchived = member.IsArchived,
            ThisMonth = months.FirstOrDefault(m => m.Year == year && m.Month == monthNo) is { } current ? ToDto(current) : null,
            FutureMonths = months
                .Where(m => m.Year != year || m.Month != monthNo)
                .Select(ToDto)
                .ToList(),
        };
    }
}
