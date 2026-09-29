using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// Where a returned transfer's money goes in the source account's jars (O1 answer 4, P72). The
/// return leg posts to unallocated; a stored zero-sum <see cref="JarAllocationKind.Return"/>
/// operation then puts back each jar's share of the departure, decided when the return is
/// recorded: a jar not archived and held in the account on the return date gets its share back,
/// whether it is still there or has since left (R2-D1: settled on the departure closing that
/// stretch, as a late payment is); any other share stays unallocated. Stored like every other jar movement,
/// so a later archive, move or restore never rewrites what the account read (rules 26, 80), and
/// every change to it is settled on the departure of a jar that has since left the account
/// (<see cref="JarDepartures.SettleAsync"/>), as every other jar share is.
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
    /// return whose amount, source and departure split this write left unchanged, and whose stored
    /// operation still agrees with that split (every jar it credits drawn by the departure on the
    /// same source, for the amount it credits), keeps the jar decision it was recorded with and
    /// only follows its date (a statement confirming a return marked by hand, a corrected date),
    /// so a jar archived or moved since never gets it re-decided. Otherwise the jars are decided
    /// now (<see cref="RecordAsync"/>). A kept share can't move out of a stretch the jar was held
    /// in the account: past the day it left (rule 80), or before it arrived (P2-20). With
    /// <paramref name="refuseKey"/> (a date the user typed) that date is refused, as for any entry
    /// of the jar's stretch there; without it (a bank's date) the return is decided again as of
    /// its date, when the jar was not there. Every write that can
    /// change a returned transfer's departure split calls this.
    /// </summary>
    public static async Task SyncAsync(
        IApplicationDbContext db, Transaction transfer, Guid sourceId, Basis before, CancellationToken cancellationToken,
        string? refuseKey = null)
    {
        var after = await BasisAsync(db, transfer, cancellationToken);
        if (after.ReturnedOn is DateOnly returnedOn && after.SameDecisionAs(before))
        {
            var kept = await OperationsAsync(db, transfer.Id, cancellationToken);
            if (kept.All(op => AgreesWith(op, sourceId, after.Departure))
                && await StaysInItsStretchesAsync(db, kept, returnedOn, refuseKey, cancellationToken))
            {
                foreach (var op in kept.Where(op => op.Date != returnedOn))
                {
                    var shares = Shares(op);
                    await JarDepartures.SettleAsync(db, op.OwnerId, op.AccountId, op.Date, shares, returnedOn, shares, cancellationToken);
                    op.Date = returnedOn;
                }
                return;
            }
        }
        await RecordAsync(db, transfer, sourceId, cancellationToken);
    }

    /// <summary>
    /// Whether every jar share the <paramref name="kept"/> operations give back can move to
    /// <paramref name="returnedOn"/>: the jar must have been held in the account that day, in its
    /// current stretch there or in one it has since left (and a departure on or after the date
    /// settles it). False (or refused, with <paramref name="refuseKey"/>) when the date falls
    /// after the jar left, or before it arrived.
    /// </summary>
    private static async Task<bool> StaysInItsStretchesAsync(
        IApplicationDbContext db, IReadOnlyList<JarAllocation> kept, DateOnly returnedOn, string? refuseKey,
        CancellationToken cancellationToken)
    {
        foreach (var op in kept.Where(op => op.Date != returnedOn))
        {
            var jarIds = op.Postings.Where(p => p.JarId is not null && p.Amount != 0m).Select(p => p.JarId!.Value).ToList();
            var jars = await db.Jars.AsNoTracking().Where(j => jarIds.Contains(j.Id)).ToListAsync(cancellationToken);
            var stretches = await JarStretches.LoadAsync(db, jarIds, cancellationToken);
            // A share settled on a departure is kept only where the account's ledger reads it: before
            // its opening date the return counts nowhere while the settlement would (R2-N2). The
            // return is decided again then, and gives that jar nothing.
            var beforeOpening = stretches.OpeningDateOf(op.AccountId) is { } opened && returnedOn < opened;
            foreach (var jar in jars)
            {
                if (jar.FundingAccountId == op.AccountId)
                {
                    if (JarLedgerReader.HeldOn(jar.FundingAccountId, jar.FundingAccountSince, op.AccountId, returnedOn))
                    {
                        continue;
                    }
                    if (stretches.LeftOn(jar.Id, op.AccountId, returnedOn) is not null)
                    {
                        if (beforeOpening)
                        {
                            return false;
                        }
                        continue;
                    }
                    // Dated before the jar arrived: HeldOn fails only when it has an arrival day.
                    var arrived = stretches.HeldElsewhereUntil(jar.Id, op.AccountId, returnedOn) ?? jar.FundingAccountSince!.Value;
                    return refuseKey is null ? false : throw DatedBeforeArrival(refuseKey, jar.Name, arrived);
                }
                if (await JarDepartures.CoveringAsync(db, op.OwnerId, jar.Id, op.AccountId, returnedOn, cancellationToken) is null)
                {
                    return refuseKey is null
                        ? false
                        : throw Refusal(refuseKey, jar.Name, await JarDepartures.LastAsync(db, jar.Id, op.AccountId, cancellationToken));
                }
                if (stretches.HeldElsewhereUntil(jar.Id, op.AccountId, returnedOn) is { } since)
                {
                    return refuseKey is null ? false : throw DatedBeforeArrival(refuseKey, jar.Name, since);
                }
                if (beforeOpening)
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static ValidationException Refusal(string key, string jarName, DateOnly left) =>
        new(new Dictionary<string, string[]>
        {
            [key] = new[]
            {
                $"This return gave money back to {jarName} while {jarName} was held in this account, and {jarName} left it on {left:d MMM yyyy}. " +
                "It can't be dated after that.",
            },
        });

    private static ValidationException DatedBeforeArrival(string key, string jarName, DateOnly arrived) =>
        new(new Dictionary<string, string[]>
        {
            [key] = new[]
            {
                $"This return gave money back to {jarName} while {jarName} was held in this account, and another account held {jarName} " +
                $"until {arrived:d MMM yyyy}. It can't be dated before that.",
            },
        });

    private static List<(Guid? JarId, decimal Amount)> Shares(JarAllocation op) =>
        op.Postings.Select(p => (p.JarId, p.Amount)).ToList();

    /// <summary>
    /// Whether a stored return operation was decided from <paramref name="departure"/> as it is
    /// now: it is on <paramref name="sourceId"/> and gives each jar back exactly what the
    /// departure draws from it there (a jar it gives nothing was decided unallocated).
    /// </summary>
    private static bool AgreesWith(JarAllocation op, Guid sourceId, IReadOnlyList<(Guid? JarId, decimal Amount)> departure) =>
        op.AccountId == sourceId
        && op.Postings.Where(p => p.JarId is not null).All(p =>
            -departure.Where(d => d.JarId == p.JarId && d.Amount < 0m).Sum(d => d.Amount) == p.Amount);

    /// <summary>
    /// Writes (or removes) <paramref name="transfer"/>'s return operation for its current
    /// <see cref="Transaction.ReturnedOn"/>, from the departure's stored jar split on
    /// <paramref name="sourceId"/> and the jars as they are now: a jar not archived gets its share
    /// back when it was held in the account on the return date, in its current stretch there, or
    /// (R2-D1) in a recorded stretch it has since left, when the account's ledger reads that date.
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
        var jars = await db.Jars
            .Where(j => drawn.Keys.Contains(j.Id) && !j.IsArchived)
            .Select(j => new { j.Id, j.FundingAccountId, j.FundingAccountSince })
            .ToListAsync(cancellationToken);
        var elsewhere = jars.Where(j => !JarLedgerReader.HeldOn(j.FundingAccountId, j.FundingAccountSince, sourceId, returnedOn)).Select(j => j.Id).ToList();
        var stretches = elsewhere.Count == 0 ? JarStretches.None : await JarStretches.LoadAsync(db, elsewhere, cancellationToken);
        // Before the account's opening date its ledger reads nothing, while the departure's share would count.
        var read = stretches.OpeningDateOf(sourceId) is { } opened && returnedOn >= opened;
        var held = jars
            .Where(j => !elsewhere.Contains(j.Id) || (read && stretches.LeftOn(j.Id, sourceId, returnedOn) is not null))
            .Select(j => j.Id)
            .ToList();
        var postings = drawn.Where(d => held.Contains(d.Key))
            .Select(d => new JarAllocationPosting { JarId = d.Key, Amount = d.Value })
            .ToList();
        var total = postings.Sum(p => p.Amount);
        if (total == 0m)
        {
            return;
        }
        postings.Add(new JarAllocationPosting { JarId = null, Amount = -total });
        // A jar held here in a stretch it has since left (moved away, or away and back) is settled
        // on the departure that closed that stretch.
        await JarDepartures.SettleAsync(db, transfer.OwnerId, sourceId, returnedOn, new List<(Guid?, decimal)>(),
            returnedOn, postings.Select(p => (p.JarId, p.Amount)).ToList(), cancellationToken);
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

    /// <summary>
    /// Removes <paramref name="transferId"/>'s return operation, if any (the return was undone or
    /// re-decided, or the transfer deleted). What it gave a jar that has since left the account is
    /// settled on the jar's departure, so the jar still holds nothing there from the day it left.
    /// </summary>
    public static async Task ClearAsync(IApplicationDbContext db, Guid transferId, CancellationToken cancellationToken)
    {
        foreach (var op in await OperationsAsync(db, transferId, cancellationToken))
        {
            await JarDepartures.SettleAsync(db, op.OwnerId, op.AccountId, op.Date, Shares(op),
                op.Date, new List<(Guid?, decimal)>(), cancellationToken);
            db.JarAllocations.Remove(op);
        }
    }
}
