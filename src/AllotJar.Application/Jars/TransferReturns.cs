using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// Where a returned transfer's money goes in the source account's jars (O1 answer 4, P65). The
/// return leg posts to unallocated; a stored zero-sum <see cref="JarAllocationKind.Return"/>
/// operation then puts back each jar's share of the departure, decided when the return is
/// recorded: a jar still on the account and not archived gets its share back, any other share
/// stays unallocated. Stored like every other jar movement, so a later archive, move or restore
/// never rewrites what the account read (rules 26, 80).
/// </summary>
public static class TransferReturns
{
    /// <summary>
    /// What a return's jar decision was made from: whether and when it was returned, from which
    /// account, for what amount, and the departure's jar split there. Taken before a write changes
    /// the transfer and handed to <see cref="SyncAsync"/> after it.
    /// </summary>
    public sealed record Basis(DateOnly? ReturnedOn, Guid? SourceId, decimal Amount, IReadOnlyList<(Guid? JarId, decimal Amount)> Departure)
    {
        /// <summary>Whether a return decided from <paramref name="other"/> still stands for this one (the date aside).</summary>
        public bool SameDecisionAs(Basis other) =>
            ReturnedOn is not null && other.ReturnedOn is not null
            && SourceId == other.SourceId && Amount == other.Amount && Departure.SequenceEqual(other.Departure);
    }

    /// <summary>The <see cref="Basis"/> of <paramref name="transfer"/> as this write leaves it so far.</summary>
    public static async Task<Basis> BasisAsync(IApplicationDbContext db, Transaction transfer, CancellationToken cancellationToken)
    {
        var departure = await DepartureAsync(db, transfer.Id, transfer.AccountId, cancellationToken);
        return new Basis(transfer.ReturnedOn, transfer.AccountId, transfer.Amount,
            departure?.Postings.Select(p => (p.JarId, p.Amount)).OrderBy(p => p.JarId).ThenBy(p => p.Amount).ToList()
            ?? new List<(Guid?, decimal)>());
    }

    /// <summary>
    /// Brings <paramref name="transfer"/>'s return operation in line with the write, given the
    /// <paramref name="before"/> taken ahead of it. A return that is no longer one is removed. A
    /// return whose amount, source and departure split are unchanged keeps the jar decision it was
    /// recorded with and only follows its date (a statement confirming a return marked by hand,
    /// a corrected date), so a jar archived or moved since never gets it re-decided. Otherwise the
    /// jars are decided now (<see cref="RecordAsync"/>).
    /// </summary>
    public static async Task SyncAsync(
        IApplicationDbContext db, Transaction transfer, Guid sourceId, Basis before, CancellationToken cancellationToken)
    {
        var after = await BasisAsync(db, transfer, cancellationToken);
        if (after.ReturnedOn is DateOnly returnedOn && after.SameDecisionAs(before))
        {
            foreach (var kept in await OperationsAsync(db, transfer.Id, cancellationToken))
            {
                kept.Date = returnedOn;
            }
            return;
        }
        await RecordAsync(db, transfer, sourceId, cancellationToken);
    }

    /// <summary>
    /// Writes (or removes) <paramref name="transfer"/>'s return operation for its current
    /// <see cref="Transaction.ReturnedOn"/>, from the departure's stored jar split on
    /// <paramref name="sourceId"/> and the jars as they are now.
    /// </summary>
    public static async Task RecordAsync(
        IApplicationDbContext db, Transaction transfer, Guid sourceId, CancellationToken cancellationToken)
    {
        await ClearAsync(db, transfer.Id, cancellationToken);
        if (transfer.ReturnedOn is not DateOnly returnedOn)
        {
            return;
        }
        var departure = await DepartureAsync(db, transfer.Id, sourceId, cancellationToken);
        var drawn = departure?.Postings
            .Where(p => p.JarId is not null && p.Amount < 0m)
            .GroupBy(p => p.JarId!.Value)
            .ToDictionary(g => g.Key, g => -g.Sum(p => p.Amount)) ?? new Dictionary<Guid, decimal>();
        if (drawn.Count == 0)
        {
            return;
        }
        var held = await db.Jars
            .Where(j => drawn.Keys.Contains(j.Id) && j.FundingAccountId == sourceId && !j.IsArchived)
            .Select(j => j.Id)
            .ToListAsync(cancellationToken);
        var postings = drawn.Where(d => held.Contains(d.Key))
            .Select(d => new JarAllocationPosting { JarId = d.Key, Amount = d.Value })
            .ToList();
        var total = postings.Sum(p => p.Amount);
        if (total == 0m)
        {
            return;
        }
        postings.Add(new JarAllocationPosting { JarId = null, Amount = -total });
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = transfer.OwnerId,
            AccountId = sourceId,
            Kind = JarAllocationKind.Return,
            Date = returnedOn,
            ReturnOfTransferId = transfer.Id,
            CreatedUtc = DateTime.UtcNow,
            Postings = postings,
        });
    }

    /// <summary>
    /// The departure's jar split on <paramref name="sourceId"/> as this write leaves it: a pending
    /// change wins, and a split this write removed (tracked as deleted, so no longer in Local)
    /// counts as none.
    /// </summary>
    private static async Task<JarAllocation?> DepartureAsync(
        IApplicationDbContext db, Guid transferId, Guid? sourceId, CancellationToken cancellationToken)
    {
        var departure = db.JarAllocations.Local
            .FirstOrDefault(a => a.TransactionId == transferId && a.AccountId == sourceId && a.Kind == JarAllocationKind.Movement);
        if (departure is null)
        {
            var stored = await db.JarAllocations
                .Include(a => a.Postings)
                .FirstOrDefaultAsync(a => a.TransactionId == transferId && a.AccountId == sourceId
                                          && a.Kind == JarAllocationKind.Movement, cancellationToken);
            departure = stored is not null && db.JarAllocations.Local.Contains(stored) ? stored : null;
        }
        return departure;
    }

    /// <summary><paramref name="transferId"/>'s return operations as this write leaves them (tracked).</summary>
    private static async Task<List<JarAllocation>> OperationsAsync(IApplicationDbContext db, Guid transferId, CancellationToken cancellationToken)
    {
        await db.JarAllocations.Include(a => a.Postings).Where(a => a.ReturnOfTransferId == transferId).LoadAsync(cancellationToken);
        return db.JarAllocations.Local.Where(a => a.ReturnOfTransferId == transferId).ToList();
    }

    /// <summary>Removes <paramref name="transferId"/>'s return operation, if any (the return was undone or the transfer deleted).</summary>
    public static async Task ClearAsync(IApplicationDbContext db, Guid transferId, CancellationToken cancellationToken)
    {
        foreach (var pending in db.JarAllocations.Local.Where(a => a.ReturnOfTransferId == transferId).ToList())
        {
            db.JarAllocations.Remove(pending);
        }
        var stored = await db.JarAllocations
            .Include(a => a.Postings)
            .Where(a => a.ReturnOfTransferId == transferId)
            .ToListAsync(cancellationToken);
        db.JarAllocations.RemoveRange(stored);
    }
}
