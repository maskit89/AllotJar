using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// Rule 80's history, kept balanced. When a jar changes account, the account it leaves keeps the
/// jar's postings (history stays with the previous account) and gets a dated
/// <see cref="JarAllocationKind.Departure"/> operation: jar −S, unallocated +S, where S is what
/// the account's other operations leave in the jar on that date. The move needs a zero balance,
/// so S is 0 when it is written; when a kept pre-move leg is later corrected (rule 49), the
/// change in the jar's share of that leg is moved into the departure, so the jar holds nothing in
/// the old account from the day it left (rule 2) while the dates before read the corrected
/// history. Money never appears or vanishes: the departure is zero-sum within the old account.
/// </summary>
public static class JarDepartures
{
    /// <summary>
    /// Records that <paramref name="jarId"/> leaves <paramref name="fromAccountId"/> on
    /// <paramref name="movedOn"/>. Written only when that account's ledger carries a posting of
    /// the jar (stored, or <paramref name="keptAdded"/> by the caller in this unit of work): with
    /// none, no kept leg can ever exist there. The caller saves.
    /// </summary>
    public static async Task RecordAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, Guid fromAccountId, DateOnly movedOn, bool keptAdded,
        CancellationToken cancellationToken)
    {
        var carries = keptAdded || await db.JarAllocationPostings
            .AnyAsync(p => p.JarId == jarId && p.JarAllocation.AccountId == fromAccountId, cancellationToken);
        if (carries)
        {
            db.JarAllocations.Add(New(ownerId, fromAccountId, jarId, movedOn, 0m));
        }
    }

    /// <summary>
    /// Rule 80's in-transit clause, as far as the old account's history needs it: a stored jar
    /// split naming the jar on a transfer leg of <paramref name="accountId"/> that has not posted
    /// yet would post there after the jar left.
    /// </summary>
    public static Task<bool> HasUnpostedLegAsync(
        IApplicationDbContext db, Guid jarId, Guid accountId, CancellationToken cancellationToken) =>
        db.JarAllocations.AnyAsync(a => a.AccountId == accountId
                                        && a.TransactionId != null
                                        && a.Postings.Any(p => p.JarId == jarId)
                                        && a.Transaction!.Type == TransactionType.Transfer
                                        && ((a.Transaction.AccountId == accountId && a.Transaction.DepartedOn == null)
                                            || (a.Transaction.TransferAccountId == accountId && a.Transaction.ReceivedOn == null)),
            cancellationToken);

    /// <summary>
    /// Rule 80's zero balance, on every date after the move: the earliest date after
    /// <paramref name="movedOn"/> on which a stored operation of <paramref name="accountId"/>
    /// moves money in or out of the jar (an income split into it ahead of payday, a payment drawn
    /// from it or a reallocation dated later). Today's balance does not see such an entry, and no
    /// departure could settle it, so the account would hold the jar's money again from that date
    /// (P51). Null when there is none.
    /// </summary>
    public static Task<DateOnly?> EntryDatedAfterAsync(
        IApplicationDbContext db, Guid jarId, Guid accountId, DateOnly movedOn, CancellationToken cancellationToken) =>
        db.JarAllocations
            .Where(a => a.AccountId == accountId
                        && a.Kind != JarAllocationKind.Departure
                        && a.Date > movedOn
                        && a.Postings.Any(p => p.JarId == jarId && p.Amount != 0m))
            .MinAsync(a => (DateOnly?)a.Date, cancellationToken);

    /// <summary>
    /// The departure that closes the stretch a leg of <paramref name="accountId"/> dated
    /// <paramref name="date"/> belongs to: the jar's earliest departure from that account dated on
    /// or after it. Null when the jar has departures there but all are earlier (the leg is dated
    /// after the jar left), or when it never left. A jar designated elsewhere with postings here
    /// but no departure at all was moved before departures were recorded: one is recorded now, on
    /// the later of <paramref name="date"/> and the last day the account's ledger touched the jar.
    /// </summary>
    public static async Task<JarAllocation?> CoveringAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, Guid accountId, DateOnly date, CancellationToken cancellationToken)
    {
        var departures = await DeparturesAsync(db, accountId, jarId, cancellationToken);
        if (departures.Count == 0)
        {
            var designated = await db.Jars.AsNoTracking().Where(j => j.Id == jarId).Select(j => j.FundingAccountId).FirstOrDefaultAsync(cancellationToken);
            if (designated == accountId)
            {
                return null;
            }
            // BackfillAsync records these at startup; this covers a residue it has not seen yet.
            var last = await db.JarAllocations
                .Where(a => a.AccountId == accountId && a.Postings.Any(p => p.JarId == jarId))
                .MaxAsync(a => (DateOnly?)a.Date, cancellationToken) ?? date;
            var held = await db.JarAllocationPostings
                .Where(p => p.JarId == jarId && p.JarAllocation.AccountId == accountId)
                .SumAsync(p => p.Amount, cancellationToken);
            var legacy = New(ownerId, accountId, jarId, last > date ? last : date, held);
            db.JarAllocations.Add(legacy);
            return legacy;
        }
        return departures.Where(d => d.Date >= date).OrderBy(d => d.Date).ThenBy(d => d.CreatedUtc).FirstOrDefault();
    }

    /// <summary>
    /// Moves the change in each departed jar's share of one leg into the departure covering the
    /// leg, so the old account's postings for the jar still sum to zero on the day it left.
    /// <paramref name="before"/> is what the leg stored (empty when new), <paramref name="after"/>
    /// what it will store (empty when cleared). A share on a jar still designated here, or dated
    /// after the jar's last departure from here, is ordinary history and is left alone.
    /// </summary>
    public static async Task SettleAsync(
        IApplicationDbContext db, string ownerId, Guid accountId,
        DateOnly beforeDate, IReadOnlyCollection<(Guid? JarId, decimal Amount)> before,
        DateOnly afterDate, IReadOnlyCollection<(Guid? JarId, decimal Amount)> after,
        CancellationToken cancellationToken)
    {
        var jarIds = before.Concat(after).Where(p => p.JarId is not null).Select(p => p.JarId!.Value).Distinct().ToList();
        if (jarIds.Count == 0)
        {
            return;
        }
        var designated = await db.Jars.AsNoTracking().Where(j => jarIds.Contains(j.Id)).ToDictionaryAsync(j => j.Id, j => j.FundingAccountId, cancellationToken);
        // The departures of these jars from this account, in one query: a jar still designated
        // here that never left it has no kept history to settle, so the common write (a leg on a
        // jar of its own account) costs no query per jar (P3-10).
        await db.JarAllocations
            .Include(a => a.Postings)
            .Where(a => a.AccountId == accountId && a.Kind == JarAllocationKind.Departure
                        && a.Postings.Any(p => p.JarId != null && jarIds.Contains(p.JarId.Value)))
            .LoadAsync(cancellationToken);
        var leftHere = db.JarAllocations.Local
            .Where(a => a.AccountId == accountId && a.Kind == JarAllocationKind.Departure)
            .SelectMany(a => a.Postings)
            .Where(p => p.JarId is not null)
            .Select(p => p.JarId!.Value)
            .ToHashSet();
        foreach (var jarId in jarIds)
        {
            var was = before.Where(p => p.JarId == jarId).Sum(p => p.Amount);
            var now = after.Where(p => p.JarId == jarId).Sum(p => p.Amount);
            if ((was == now && beforeDate == afterDate)
                || (designated.GetValueOrDefault(jarId) == accountId && !leftHere.Contains(jarId)))
            {
                continue;
            }
            if (was != 0m && await CoveringAsync(db, ownerId, jarId, accountId, beforeDate, cancellationToken) is { } left)
            {
                Shift(left, jarId, was);
            }
            if (now != 0m)
            {
                if (await CoveringAsync(db, ownerId, jarId, accountId, afterDate, cancellationToken) is { } leaves)
                {
                    Shift(leaves, jarId, -now);
                }
                else if (designated.GetValueOrDefault(jarId) != accountId)
                {
                    // The writers refuse a kept share dated after the jar left (DatedAfterDeparture).
                    throw new InvalidOperationException("A jar's share cannot be posted to an account after the jar left it.");
                }
            }
        }
    }

    /// <summary>
    /// P3-8: records the departure every move made before departures were recorded still lacks —
    /// for each jar with postings in an account it is no longer designated to and no departure
    /// there, one dated on the last day that account's ledger touched the jar, settling what the
    /// postings leave in it (S = their sum, as <see cref="CoveringAsync"/> records one lazily).
    /// Such a residue (a kept payment corrected on the old code, which settled nothing) blocked the
    /// jar's archive until a kept entry happened to be edited. Idempotent: a jar and account with
    /// a departure are left alone. Saves; returns how many it recorded. Run at startup.
    /// </summary>
    public static async Task<int> BackfillAsync(IApplicationDbContext db, CancellationToken cancellationToken)
    {
        var postings = await db.JarAllocationPostings
            .AsNoTracking()
            .Where(p => p.JarId != null && p.Jar != null && p.JarAllocation.AccountId != p.Jar.FundingAccountId)
            .Select(p => new
            {
                JarId = p.JarId!.Value,
                p.JarAllocation.AccountId,
                p.JarAllocation.OwnerId,
                p.JarAllocation.Date,
                p.JarAllocation.Kind,
                p.Amount,
            })
            .ToListAsync(cancellationToken);
        var recorded = 0;
        foreach (var kept in postings.GroupBy(p => (p.JarId, p.AccountId)))
        {
            if (kept.Any(p => p.Kind == JarAllocationKind.Departure))
            {
                continue;
            }
            db.JarAllocations.Add(New(kept.First().OwnerId, kept.Key.AccountId, kept.Key.JarId, kept.Max(p => p.Date), kept.Sum(p => p.Amount)));
            recorded++;
        }
        if (recorded > 0)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        return recorded;
    }

    /// <summary>The day the jar last left the account.</summary>
    public static async Task<DateOnly> LastAsync(IApplicationDbContext db, Guid jarId, Guid accountId, CancellationToken cancellationToken) =>
        (await DeparturesAsync(db, accountId, jarId, cancellationToken)).Max(d => d.Date);

    private static void Shift(JarAllocation departure, Guid jarId, decimal amount)
    {
        departure.Postings.Single(p => p.JarId == jarId).Amount += amount;
        departure.Postings.Single(p => p.JarId is null).Amount -= amount;
    }

    private static async Task<List<JarAllocation>> DeparturesAsync(
        IApplicationDbContext db, Guid accountId, Guid jarId, CancellationToken cancellationToken)
    {
        // Load (tracked) what is stored, then read the tracked set so a departure added or
        // adjusted earlier in this unit of work is the one adjusted again.
        await db.JarAllocations
            .Include(a => a.Postings)
            .Where(a => a.AccountId == accountId && a.Kind == JarAllocationKind.Departure && a.Postings.Any(p => p.JarId == jarId))
            .LoadAsync(cancellationToken);
        return db.JarAllocations.Local
            .Where(a => a.AccountId == accountId && a.Kind == JarAllocationKind.Departure && a.Postings.Any(p => p.JarId == jarId))
            .ToList();
    }

    private static JarAllocation New(string ownerId, Guid accountId, Guid jarId, DateOnly date, decimal held) => new()
    {
        OwnerId = ownerId,
        AccountId = accountId,
        Kind = JarAllocationKind.Departure,
        Date = date,
        CreatedUtc = DateTime.UtcNow,
        Postings = new List<JarAllocationPosting>
        {
            new() { JarId = jarId, Amount = -held },
            new() { JarId = null, Amount = held },
        },
    };

    internal static ValidationException DatedAfterDeparture(string jarName, DateOnly left) =>
        new(new Dictionary<string, string[]>
        {
            ["Date"] = new[]
            {
                $"This entry moved money in {jarName} while {jarName} was held in this account, and {jarName} left it on {left:d MMM yyyy}. " +
                "It can't be dated after that.",
            },
        });
}
