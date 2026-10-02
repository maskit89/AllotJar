using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Commands.DismissJarCycle;

public class DismissJarCycleCommandHandler : IRequestHandler<DismissJarCycleCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DismissJarCycleCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(DismissJarCycleCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var jar = await _db.Jars.FirstOrDefaultAsync(j => j.Id == request.JarId, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.JarId} was not found.");
        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);

        // Only a cycle that is actually in the missed state can be dismissed: the open one, its
        // deadline arrived. (A funded one has already rolled forward on its own.)
        if (jar.Kind != JarKind.Recurring || jar.CycleDeadline != request.Deadline)
        {
            throw JarAccounts.Validation("Deadline", $"{jar.Name} has no missed cycle due {request.Deadline:d MMM yyyy}.");
        }
        if (request.Deadline > today)
        {
            throw JarAccounts.Validation("Deadline",
                $"{jar.Name}'s cycle due {request.Deadline:d MMM yyyy} has not been missed; there is nothing to dismiss.");
        }

        var snapshot = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken);
        var outcome = JarCycles.UnpaidCloseOutcome(jar, snapshot.BalanceOf(jar.Id));
        await JarCycles.CloseOpenCycleAsync(_db, userId, jar, outcome, null, today, cancellationToken);

        await _db.SaveChangesAsync(cancellationToken);
        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
