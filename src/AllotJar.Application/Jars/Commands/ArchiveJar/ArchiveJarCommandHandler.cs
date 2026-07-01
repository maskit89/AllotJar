using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.ArchiveJar;

public class ArchiveJarCommandHandler
    : IRequestHandler<ArchiveJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ArchiveJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(
        ArchiveJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var fund = await _db.Jars
            .FirstOrDefaultAsync(f => f.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Sinking fund {request.Id} was not found.");

        if (fund.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        fund.IsArchived = request.Archived;
        await _db.SaveChangesAsync(cancellationToken);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var tracked = await JarBalances.ComputeAsync(_db, userId, cancellationToken);
        var balance = fund.OpeningBalance + tracked.GetValueOrDefault(fund.Id);
        var required = JarAccrualCalculator.RequiredMonthlyContribution(fund, asOf, balance);
        return fund.ToDto(balance, required, asOf);
    }
}
