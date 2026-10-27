using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// Recalculate on every payment (Christopher, 27 Oct 2026): money leaving a Recurring jar
/// replants its current and later months from what the jar holds now, whether or not the
/// payment is ever marked as the cycle's. A cycle that held its target on its deadline rolls
/// forward Funded and plans the next one from the full balance (0 a month); the bill paid from
/// the jar afterwards brings it to what is left, and the months already created follow. Nothing
/// here closes a cycle or links a payment (rule 83: the user marks the cycle paid and picks the
/// payment, never inferred), so a bill paid before the deadline and not marked paid still leaves
/// the cycle open, and short on the deadline it reads Deadline missed (rule 20). Skipped months
/// (rule 60) and amounts typed by hand (O3b) are kept by <see cref="JarPlanner.ReplantAsync"/>.
/// A write takes the jars its transactions draw from before it (<see cref="DrawnFromAsync"/>)
/// and hands them to <see cref="ReplantAsync"/> once saved, which adds the ones they draw from
/// after it: a draw moved off a jar, or deleted, gives the money back to the plan too.
/// </summary>
public static class JarDrawReplants
{
    /// <summary>
    /// The Recurring jars <paramref name="transactionIds"/> (and their transfers' fees) draw from as
    /// saved: a payment's line or slice on a jar's savings line (rule 79), and a stored jar split
    /// that takes money out of a jar (a payment "paid from" a jar, a transfer leaving one). Money
    /// put into a jar is not a draw: it never shrinks the month's plan (rule 14). Read from the
    /// database, so call it before the write for what the transactions drew from then.
    /// </summary>
    public static async Task<HashSet<Guid>> DrawnFromAsync(
        IApplicationDbContext db, string ownerId, IEnumerable<Guid> transactionIds, CancellationToken cancellationToken)
    {
        var ids = transactionIds.Distinct().ToList();
        if (ids.Count == 0)
        {
            return new HashSet<Guid>();
        }
        ids.AddRange(await db.Transactions
            .AsNoTracking()
            .Where(t => t.FeeForTransferId != null && ids.Contains(t.FeeForTransferId.Value))
            .Select(t => t.Id)
            .ToListAsync(cancellationToken));

        var lineIds = await db.Transactions
            .AsNoTracking()
            .Where(t => ids.Contains(t.Id) && t.OwnerId == ownerId && t.Type == TransactionType.Expense && t.BudgetItemId != null)
            .Select(t => t.BudgetItemId!.Value)
            .ToListAsync(cancellationToken);
        lineIds.AddRange(await db.TransactionSplits
            .AsNoTracking()
            .Where(s => ids.Contains(s.TransactionId) && s.BudgetItemId != null
                        && s.Transaction.OwnerId == ownerId && s.Transaction.Type == TransactionType.Expense)
            .Select(s => s.BudgetItemId!.Value)
            .ToListAsync(cancellationToken));

        var jarIds = lineIds.Count == 0
            ? new List<Guid>()
            : await db.BudgetItems
                .AsNoTracking()
                .Where(i => lineIds.Contains(i.Id) && i.SavingsId != null)
                .Select(i => i.SavingsId!.Value)
                .ToListAsync(cancellationToken);
        jarIds.AddRange(await db.JarAllocationPostings
            .AsNoTracking()
            .Where(p => p.JarId != null && p.Amount < 0m
                        && p.JarAllocation.TransactionId != null && ids.Contains(p.JarAllocation.TransactionId.Value)
                        && p.JarAllocation.OwnerId == ownerId)
            .Select(p => p.JarId!.Value)
            .ToListAsync(cancellationToken));
        if (jarIds.Count == 0)
        {
            return new HashSet<Guid>();
        }

        var distinct = jarIds.Distinct().ToList();
        return (await db.Jars
            .AsNoTracking()
            .Where(j => distinct.Contains(j.Id) && j.OwnerId == ownerId && j.Kind == JarKind.Recurring)
            .Select(j => j.Id)
            .ToListAsync(cancellationToken))
            .ToHashSet();
    }

    /// <summary>
    /// Replants every Recurring jar <paramref name="drawnBefore"/> names or
    /// <paramref name="transactionIds"/> draw from now, once the write is saved. A cycle whose
    /// deadline has arrived settles first (rule 21: Funded when the jar held its target the day
    /// before), so the plan is toward the cycle the jar is really on; that roll replants on its
    /// own. Saves when anything changed.
    /// </summary>
    public static async Task ReplantAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> drawnBefore, IEnumerable<Guid> transactionIds,
        CancellationToken cancellationToken)
    {
        var jarIds = new HashSet<Guid>(drawnBefore);
        jarIds.UnionWith(await DrawnFromAsync(db, ownerId, transactionIds, cancellationToken));
        if (jarIds.Count == 0)
        {
            return;
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var replanted = false;
        foreach (var jarId in jarIds.Order())
        {
            if (await JarCycles.SettleAsync(db, ownerId, today, cancellationToken, jarId))
            {
                continue;
            }
            var jar = await db.Jars.FirstOrDefaultAsync(j => j.Id == jarId && j.OwnerId == ownerId, cancellationToken);
            if (jar is null || jar.Kind != JarKind.Recurring || !JarSchedule.IsPlanning(jar))
            {
                continue;
            }
            await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken);
            replanted = true;
        }
        if (replanted)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
    }
}
