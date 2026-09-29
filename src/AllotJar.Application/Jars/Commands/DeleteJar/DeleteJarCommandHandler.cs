using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Jars.Commands.DeleteJar;

public class DeleteJarCommandHandler : IRequestHandler<DeleteJarCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DeleteJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(DeleteJarCommand request, CancellationToken cancellationToken)
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

        // Rule 84: only a jar that never held money can go; anything with a money history is
        // archived so that history is preserved (rule 25).
        if (await JarUsage.HasHeldMoneyAsync(_db, userId, jar.Id, cancellationToken))
        {
            throw JarAccounts.Validation("Id",
                $"{jar.Name} has held money, so it cannot be deleted. Archive it instead to keep its history.");
        }

        // Its lines were plans only (no transaction was ever assigned to one — that would count
        // as money spent from the jar); rule 84 removes them, past months included. Its cycles
        // (a Recurring jar that was never funded) and its definition and archive history go with it.
        var lines = await _db.BudgetItems
            .Where(i => i.SavingsId == jar.Id)
            .ToListAsync(cancellationToken);
        _db.BudgetItems.RemoveRange(lines);
        var cycles = await _db.JarCycles
            .Where(c => c.JarId == jar.Id)
            .ToListAsync(cancellationToken);
        _db.JarCycles.RemoveRange(cycles);
        var revisions = await _db.JarRevisions
            .Where(r => r.JarId == jar.Id)
            .ToListAsync(cancellationToken);
        _db.JarRevisions.RemoveRange(revisions);
        var archivePeriods = await _db.JarArchivePeriods
            .Where(p => p.JarId == jar.Id)
            .ToListAsync(cancellationToken);
        _db.JarArchivePeriods.RemoveRange(archivePeriods);
        _db.Jars.Remove(jar);

        await _db.SaveChangesAsync(cancellationToken);
    }
}
