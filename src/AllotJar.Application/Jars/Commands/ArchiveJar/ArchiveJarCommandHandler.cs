using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;

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

        var jar = await _db.Jars
            .FirstOrDefaultAsync(f => f.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.Id} was not found.");

        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var snapshot = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken);

        if (request.Archived && !jar.IsArchived)
        {
            // Rule 26: archiving never discards money or erases a shortfall. The jar must be at
            // zero — reallocated away, or its deficit covered — before it can be put away.
            var balance = snapshot.BalanceOf(jar.Id);
            if (balance is null)
            {
                throw JarAccounts.Validation("Id", $"{jar.Name}'s balance is not available today, so it cannot be archived yet.");
            }
            if (balance != 0m)
            {
                throw JarAccounts.Validation("Id",
                    balance > 0m
                        ? $"{jar.Name} still holds {balance:0.##}. Move it to another jar or to unallocated funds before archiving."
                        : $"{jar.Name} is {(-balance):0.##} overdrawn. Cover the shortfall from another jar or unallocated funds before archiving.");
            }
        }

        if (request.Archived && !jar.IsArchived)
        {
            // Rule 27: the remaining contribution this month and every later month's line are
            // cancelled; past months, transactions and balances are untouched.
            await SavingsLines.CancelPlansAsync(_db, userId, jar, today, cancellationToken);
        }
        if (request.Archived != jar.IsArchived)
        {
            // Dated, so a month that ended before today still reads the jar as it was then (W05).
            jar.ArchivedOn = request.Archived ? today : null;
        }
        jar.IsArchived = request.Archived;
        if (!request.Archived && !jar.IsCompleted)
        {
            // Restoring is the inverse: the jar saves again from this month on (its lines were
            // removed when it was archived). A completed jar stays completed (rule 55).
            await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
        }
        await _db.SaveChangesAsync(cancellationToken);

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
