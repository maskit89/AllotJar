using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.CompleteJar;

public class CompleteJarCommandHandler : IRequestHandler<CompleteJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CompleteJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(CompleteJarCommand request, CancellationToken cancellationToken)
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
        if (jar.Kind != JarKind.Goal)
        {
            throw JarAccounts.Validation("Id",
                $"{jar.Name} is a recurring jar: mark its cycle paid when the bill is settled, or archive it when it is no longer needed.");
        }
        if (jar.IsCompleted)
        {
            throw JarAccounts.Validation("Id", $"{jar.Name} is already completed.");
        }
        if (jar.IsArchived)
        {
            throw JarAccounts.Validation("Id", $"{jar.Name} is archived.");
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var snapshot = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken);
        var balance = snapshot.BalanceOf(jar.Id);
        if (balance is null)
        {
            throw JarAccounts.Validation("Id", $"{jar.Name}'s balance is not available today, so it cannot be completed yet.");
        }
        if (balance < 0m)
        {
            // Open question (HANDOVER O3): what completing an overdrawn jar means. Until it is
            // answered the shortfall is covered first — nothing is invented to close it.
            throw JarAccounts.Validation("Id",
                $"{jar.Name} is {(-balance.Value):0.##} overdrawn. Cover the shortfall from another jar or unallocated funds before completing it.");
        }

        // Rule 55: no more planned contributions, from this month on; rule 56: the balance stays.
        jar.CompletedOn = today;
        await SavingsLines.CancelPlansAsync(_db, userId, jar, today, cancellationToken);
        await _db.SaveChangesAsync(cancellationToken);

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
