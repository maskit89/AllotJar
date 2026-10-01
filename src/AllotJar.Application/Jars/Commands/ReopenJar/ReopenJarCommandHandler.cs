using MediatR;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Commands.ReopenJar;

public class ReopenJarCommandHandler : IRequestHandler<ReopenJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ReopenJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(ReopenJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Under the ledger lock of the jar's account (P11), as completing is: the replant below
        // plans from the balance the jar holds, which a racing draw would otherwise change.
        var (jar, write) = await JarLocks.LoadLockedAsync(_db, request.Id, null, cancellationToken);
        await using var _ = write;

        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (!jar.IsCompleted)
        {
            throw JarAccounts.Validation("Id", $"{jar.Name} is not completed, so there is nothing to reopen.");
        }
        if (jar.IsArchived)
        {
            throw JarAccounts.Validation("Id", $"{jar.Name} is archived. Restore it first, then reopen it.");
        }

        // The plan restarts from the money still in the jar, from this month on, exactly as an
        // edit replants it (rule 46); past months, transactions and balances are untouched.
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        jar.CompletedOn = null;
        await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
