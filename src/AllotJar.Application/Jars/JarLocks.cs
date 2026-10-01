using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Jars;

/// <summary>
/// The ledger lock (P11) for a write that changes a jar itself (archive, complete, a change of
/// account): the account holding the jar is locked before the jar is read, so a payment or
/// reallocation into the jar either finishes first and is seen, or waits and then sees the jar
/// archived or moved (JL-P2-5).
/// </summary>
public static class JarLocks
{
    /// <summary>
    /// Locks the account holding <paramref name="jarId"/> (and <paramref name="alsoAccountId"/>,
    /// the account a move takes it to) and loads the jar, tracked, as committed under the lock.
    /// Throws <see cref="NotFoundException"/> when there is no such jar. The caller checks the
    /// owner, commits the returned write after saving and disposes it.
    /// </summary>
    public static async Task<(Jar Jar, ILedgerWrite? Write)> LoadLockedAsync(
        IApplicationDbContext db, Guid jarId, Guid? alsoAccountId, CancellationToken cancellationToken)
    {
        // The jar may change account between the read and the lock: lock again on the account it
        // moved to. A move needs the same lock, so this settles after one more round at most.
        for (var attempt = 0; ; attempt++)
        {
            var accountId = await HeldInAsync(db, jarId, cancellationToken);
            var ids = alsoAccountId is Guid other ? new[] { accountId, other } : new[] { accountId };
            var write = await db.BeginLedgerWriteAsync(ids, cancellationToken);
            if (write is not null && attempt < 3 && await HeldInAsync(db, jarId, cancellationToken) != accountId)
            {
                await write.DisposeAsync();
                continue;
            }
            try
            {
                var jar = await db.Jars.FirstOrDefaultAsync(j => j.Id == jarId, cancellationToken)
                    ?? throw new NotFoundException($"Jar {jarId} was not found.");
                return (jar, write);
            }
            catch
            {
                if (write is not null)
                {
                    await write.DisposeAsync();
                }
                throw;
            }
        }
    }

    private static async Task<Guid> HeldInAsync(IApplicationDbContext db, Guid jarId, CancellationToken cancellationToken) =>
        await db.Jars.AsNoTracking()
            .Where(j => j.Id == jarId)
            .Select(j => (Guid?)j.FundingAccountId)
            .FirstOrDefaultAsync(cancellationToken)
        ?? throw new NotFoundException($"Jar {jarId} was not found.");
}
