using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

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
        var ledger = await JarLedgerReader.LoadAsync(_db, userId, cancellationToken);
        var snapshot = ledger.At(today);

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
            // Money on its way counts too: an entry that names the jar but hasn't reached the
            // account by today (a transfer in transit, an entry dated later) would move money in or
            // out of the jar once it was put away (#282 review P2-1).
            if (await WaitingAsync(jar, today, cancellationToken) is { Count: > 0 } waiting)
            {
                throw JarAccounts.Validation("Id",
                    $"{jar.Name} has entries that haven't reached the account yet: {string.Join("; ", waiting)}. "
                    + $"Archive it once they have and its balance is zero, or take {jar.Name} out of them first.");
            }
        }

        if (request.Archived && !jar.IsArchived)
        {
            // Rule 27: the remaining contribution this month and every later month's line are
            // cancelled; past months, transactions and balances are untouched. A month the user
            // skipped stays skipped, so a restore plans around it (SC-P2-3).
            await SavingsLines.CancelPlansAsync(_db, userId, jar, today, cancellationToken, keepSkipped: true);
        }
        if (request.Archived != jar.IsArchived)
        {
            // Dated, so a month that ended before today still reads the jar as it was then (W05).
            // Restoring keeps the stretch it spent archived, so the months that ended in it still
            // read it as archived (P2-19); an archive with no recorded day has no stretch to keep.
            if (!request.Archived && jar.ArchivedOn is { } archivedOn && archivedOn < today)
            {
                _db.JarArchivePeriods.Add(new JarArchivePeriod { JarId = jar.Id, ArchivedOn = archivedOn, RestoredOn = today });
            }
            jar.ArchivedOn = request.Archived ? today : null;
        }
        jar.IsArchived = request.Archived;
        if (!request.Archived && !jar.IsCompleted)
        {
            // Restoring is the inverse: the jar saves again from this month on (its lines were
            // removed when it was archived). A completed jar stays completed (rule 55).
            await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken, ledger);
        }
        await _db.SaveChangesAsync(cancellationToken);

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }

    /// <summary>The stored jar answers in the jar's account naming it whose leg has not posted by <paramref name="today"/>, described for the refusal.</summary>
    private async Task<List<string>> WaitingAsync(Jar jar, DateOnly today, CancellationToken cancellationToken)
    {
        var legs = await _db.JarAllocations.AsNoTracking()
            .Include(a => a.Postings)
            .Include(a => a.Transaction).ThenInclude(t => t!.Account)
            .Include(a => a.Transaction).ThenInclude(t => t!.TransferAccount)
            .Where(a => a.AccountId == jar.FundingAccountId && a.TransactionId != null
                && a.Postings.Any(p => p.JarId == jar.Id && p.Amount != 0m))
            .ToListAsync(cancellationToken);
        return legs
            .Where(a => a.Transaction is not null)
            .Select(a => (Leg: a, Posts: JarMovements.PostsOn(a.Transaction!, a.AccountId)))
            // A receipt sent back never reaches the account, and its answer was cleared with it.
            .Where(l => l.Posts is DateOnly posts ? posts > today : l.Leg.Transaction!.ReturnedOn is null)
            .OrderBy(l => l.Posts ?? DateOnly.MaxValue)
            .Select(l =>
            {
                var t = l.Leg.Transaction!;
                var amount = l.Leg.Postings.Where(p => p.JarId == jar.Id).Sum(p => p.Amount);
                var when = l.Posts is DateOnly posts ? $"on {posts:d MMM yyyy}"
                    : t.DepartedOn is null ? "waiting for its departure" : "not received yet";
                // A transfer is named by the account at its other end.
                var other = t.Type != TransactionType.Transfer ? null : amount > 0m ? t.Account?.Name : t.TransferAccount?.Name;
                return amount > 0m
                    ? $"{amount:0.##} in from {other ?? t.Payee} ({when})"
                    : $"{-amount:0.##} out {(other is null ? $"for {t.Payee}" : $"to {other}")} ({when})";
            })
            .ToList();
    }
}
