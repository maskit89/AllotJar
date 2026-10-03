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

        // Under the ledger lock of the jar's account (P11, JL-P2-5): a draw racing the completion
        // lands before the balance check below, or waits for it.
        var (jar, write) = await JarLocks.LoadLockedAsync(_db, request.Id, null, cancellationToken);
        await using var _ = write;

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
            // P41, kept by O3a (answered 1 October 2026): an overdrawn Goal is not completed; the
            // refusal says how much to cover first, in the budget currency (the jar's account is
            // in it, rule 85). Nothing is invented to close the shortfall.
            var currency = await _db.Accounts.AsNoTracking()
                .Where(a => a.Id == jar.FundingAccountId)
                .Select(a => a.Currency)
                .FirstAsync(cancellationToken);
            var shortfall = $"{-balance.Value:0.00} {currency.Value}";
            throw JarAccounts.Validation("Id",
                $"{jar.Name} is {shortfall} overdrawn. Cover the {shortfall} shortfall from another jar or unallocated funds first, then mark it completed.");
        }

        // Rule 55: no more planned contributions, from this month on; rule 56: the balance stays.
        jar.CompletedOn = today;
        await SavingsLines.CancelPlansAsync(_db, userId, jar, today, cancellationToken);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }
}
