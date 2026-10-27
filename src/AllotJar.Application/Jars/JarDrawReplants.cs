using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// What a write's Recurring jars looked like before it (<see cref="JarDrawReplants.BeforeAsync"/>):
/// the jars it touched, the ones of those it drew from, and what each held entering the current
/// month and today.
/// </summary>
public sealed class JarDrawsBefore
{
    public static readonly JarDrawsBefore None = new(new HashSet<Guid>(), new HashSet<Guid>(), new Dictionary<Guid, (decimal, decimal)>());

    internal JarDrawsBefore(HashSet<Guid> touched, HashSet<Guid> drawn, Dictionary<Guid, (decimal Opening, decimal Now)> balances)
    {
        Touched = touched;
        Drawn = drawn;
        Balances = balances;
    }

    internal HashSet<Guid> Touched { get; }
    internal HashSet<Guid> Drawn { get; }
    internal Dictionary<Guid, (decimal Opening, decimal Now)> Balances { get; }

    /// <summary>The same, without <paramref name="jarIds"/> (replanted by the caller already).</summary>
    public JarDrawsBefore Without(IEnumerable<Guid> jarIds)
    {
        var skip = jarIds.ToHashSet();
        return new(Touched.Where(id => !skip.Contains(id)).ToHashSet(), Drawn.Where(id => !skip.Contains(id)).ToHashSet(),
            Balances.Where(b => !skip.Contains(b.Key)).ToDictionary(b => b.Key, b => b.Value));
    }
}

/// <summary>
/// Recalculate on every payment (Christopher, 27 Oct 2026; rule 93): money leaving a Recurring
/// jar replants its current and later months from what the jar holds now, whether or not the
/// payment is ever marked as the cycle's. A cycle that held its target on its deadline rolls
/// forward Funded and plans the next one from the full balance (0 a month); the bill paid from
/// the jar afterwards brings it to what is left, and the months already created follow. Nothing
/// here closes a cycle or links a payment (rule 83: the user marks the cycle paid and picks the
/// payment, never inferred), so a bill paid before the deadline and not marked paid still leaves
/// the cycle open, and short on the deadline it reads Deadline missed (rule 20). Skipped months
/// (rule 60) and later months typed by hand (O3b) are kept by <see cref="JarPlanner.ReplantAsync"/>.
///
/// A write takes <see cref="BeforeAsync"/> before it and hands it to <see cref="ReplantAsync"/>
/// once saved. A jar is replanted when the write changed a draw from it (a payment on its line,
/// a slice, money "paid from" it or a transfer out of it: added, edited, moved or deleted), or
/// when it left the jar holding less, today or entering this month (money put into it taken back:
/// an income's or transfer's jar split lowered or deleted, a refund refill deleted, a move to
/// another jar). Money put in never replants (rule 14: it doesn't lower the month's plan).
/// A payment dated ahead replants nothing until another write or a month start (a follow-up,
/// #402 review P2-3).
/// </summary>
public static class JarDrawReplants
{
    /// <summary>
    /// The Recurring jars <paramref name="transactionIds"/> (and their transfers' fees) touch as
    /// saved, plus <paramref name="jarIds"/>, with what each held: call it before the write.
    /// </summary>
    public static async Task<JarDrawsBefore> BeforeAsync(
        IApplicationDbContext db, string ownerId, IEnumerable<Guid> transactionIds, CancellationToken cancellationToken,
        IEnumerable<Guid>? jarIds = null)
    {
        var (touched, drawn) = await TouchedAsync(db, ownerId, transactionIds.ToList(), cancellationToken);
        if (jarIds is not null)
        {
            touched.UnionWith(await RecurringAsync(db, ownerId, jarIds.ToList(), cancellationToken));
        }
        if (touched.Count == 0)
        {
            return JarDrawsBefore.None;
        }
        var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        return new JarDrawsBefore(touched, drawn, await BalancesAsync(db, ownerId, touched, ledger, cancellationToken));
    }

    /// <summary>
    /// Once the write is saved: replants every Recurring jar of <paramref name="before"/> or of
    /// <paramref name="transactionIds"/> as saved now whose draws changed or that holds less than
    /// before (the class summary). A cycle whose deadline has arrived settles first (rule 21:
    /// Funded when the jar held its target the day before), so the plan is toward the cycle the
    /// jar is really on; that roll replants on its own. Saves when anything changed. Losing a race
    /// to a page settling the same cycle, or to an edit of the jar's lines, leaves the write as
    /// saved: the next read or write settles and replants.
    /// </summary>
    public static async Task ReplantAsync(
        IApplicationDbContext db, string ownerId, JarDrawsBefore before, IEnumerable<Guid> transactionIds,
        CancellationToken cancellationToken)
    {
        var ids = transactionIds.ToList();
        var (touched, drawn) = await TouchedAsync(db, ownerId, ids, cancellationToken);
        touched.UnionWith(before.Touched);
        drawn.UnionWith(before.Drawn);
        if (touched.Count == 0)
        {
            return;
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        try
        {
            var rolled = new HashSet<Guid>();
            foreach (var jarId in touched.Order())
            {
                if (await JarCycles.SettleAsync(db, ownerId, today, cancellationToken, jarId))
                {
                    rolled.Add(jarId);
                }
            }
            touched.ExceptWith(rolled);
            if (touched.Count == 0)
            {
                return;
            }

            // A replant moves no money: one load of the saved ledger serves every jar (P3-10).
            var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
            var after = await BalancesAsync(db, ownerId, touched, ledger, cancellationToken);
            // A jar these transactions reach only now held, before the write, what it holds without them.
            var newcomers = touched.Where(id => !drawn.Contains(id) && !before.Balances.ContainsKey(id)).ToList();
            var without = newcomers.Count == 0
                ? new Dictionary<Guid, (decimal Opening, decimal Now)>()
                : await BalancesAsync(db, ownerId, newcomers,
                    await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, excludeTransactionIds: ids), cancellationToken);

            var replanted = false;
            foreach (var jarId in touched.Order())
            {
                if (!after.TryGetValue(jarId, out var now))
                {
                    continue;
                }
                var then = before.Balances.TryGetValue(jarId, out var b) ? b : without.GetValueOrDefault(jarId, now);
                if (!drawn.Contains(jarId) && now.Now >= then.Now && now.Opening >= then.Opening)
                {
                    continue;
                }
                var jar = await db.Jars.FirstAsync(j => j.Id == jarId, cancellationToken);
                await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken, ledger);
                replanted = true;
            }
            if (replanted)
            {
                await db.SaveChangesAsync(cancellationToken);
            }
        }
        catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || JarCycles.IsCollision(ex))
        {
            // The write itself is saved; a read settling the cycle, or an edit of the jar's lines,
            // got there first. The next read or write settles and replants (#402 review P3-3).
            db.DiscardChanges();
        }
    }

    /// <summary>
    /// The planning Recurring jars <paramref name="ids"/> (and their transfers' fees) touch as
    /// saved — a line or slice on a jar's savings line, a stored jar split — and the ones of those
    /// they draw from: a payment's line or slice (rule 79), a split taking money out of a jar.
    /// One query for the jars, and one more only when there are any.
    /// </summary>
    private static async Task<(HashSet<Guid> Touched, HashSet<Guid> Drawn)> TouchedAsync(
        IApplicationDbContext db, string ownerId, List<Guid> ids, CancellationToken cancellationToken)
    {
        if (ids.Count == 0)
        {
            return (new HashSet<Guid>(), new HashSet<Guid>());
        }
        var rows = db.Transactions
            .Where(t => t.OwnerId == ownerId && (ids.Contains(t.Id) || (t.FeeForTransferId != null && ids.Contains(t.FeeForTransferId.Value))));
        var lines = rows
            .Where(t => t.BudgetItem != null && t.BudgetItem.SavingsId != null)
            .Select(t => new { JarId = t.BudgetItem!.SavingsId!.Value, Draw = t.Type == TransactionType.Expense });
        var slices = db.TransactionSplits
            .Where(s => rows.Any(t => t.Id == s.TransactionId) && s.BudgetItem != null && s.BudgetItem.SavingsId != null)
            .Select(s => new { JarId = s.BudgetItem!.SavingsId!.Value, Draw = s.Transaction.Type == TransactionType.Expense });
        var postings = db.JarAllocationPostings
            .Where(p => p.JarId != null && p.JarAllocation.TransactionId != null && rows.Any(t => t.Id == p.JarAllocation.TransactionId))
            .Select(p => new { JarId = p.JarId!.Value, Draw = p.Amount < 0m });
        var found = await lines.Concat(slices).Concat(postings).AsNoTracking().ToListAsync(cancellationToken);
        if (found.Count == 0)
        {
            return (new HashSet<Guid>(), new HashSet<Guid>());
        }
        var recurring = await RecurringAsync(db, ownerId, found.Select(f => f.JarId).Distinct().ToList(), cancellationToken);
        return (recurring, found.Where(f => f.Draw && recurring.Contains(f.JarId)).Select(f => f.JarId).ToHashSet());
    }

    private static async Task<HashSet<Guid>> RecurringAsync(
        IApplicationDbContext db, string ownerId, List<Guid> jarIds, CancellationToken cancellationToken) =>
        jarIds.Count == 0
            ? new HashSet<Guid>()
            : (await db.Jars
                .AsNoTracking()
                .Where(j => jarIds.Contains(j.Id) && j.OwnerId == ownerId && j.Kind == JarKind.Recurring
                            && !j.IsArchived && j.CompletedOn == null)
                .Select(j => j.Id)
                .ToListAsync(cancellationToken))
            .ToHashSet();

    /// <summary>What each jar held entering the current month and today, as <see cref="JarPlanner.BalancesAsync"/> reads them.</summary>
    private static async Task<Dictionary<Guid, (decimal Opening, decimal Now)>> BalancesAsync(
        IApplicationDbContext db, string ownerId, IEnumerable<Guid> jarIds, JarLedgerSource ledger, CancellationToken cancellationToken)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var result = new Dictionary<Guid, (decimal, decimal)>();
        foreach (var jarId in jarIds)
        {
            var jar = ledger.Jars.FirstOrDefault(j => j.Id == jarId);
            if (jar is null)
            {
                continue;
            }
            var (opening, now, _) = await JarPlanner.BalancesAsync(db, ownerId, jar, today, 0m, cancellationToken, ledger);
            result[jarId] = (opening, now);
        }
        return result;
    }
}
