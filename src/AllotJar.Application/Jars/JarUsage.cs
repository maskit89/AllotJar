using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Jars;

/// <summary>
/// Rule 84 (W04): a jar may be deleted only when it never held money — nothing was ever
/// allocated to it and nothing was ever spent from it. Every other jar is archived instead
/// (rules 25–27), so its history stays. "Held money" is read from the same sources the ledger
/// reads: a stored allocation posting against the jar (money set aside at creation, a move, an
/// allocated receipt or transfer leg) or a transaction — whole or a split slice — assigned to
/// one of its Savings lines (the derived attribution of rule 79).
/// </summary>
public static class JarUsage
{
    /// <summary>The ids among <paramref name="jarIds"/> that have ever held money.</summary>
    public static async Task<HashSet<Guid>> EverHeldMoneyAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> jarIds, CancellationToken cancellationToken)
    {
        if (jarIds.Count == 0)
        {
            return new HashSet<Guid>();
        }
        var ids = jarIds.ToList();
        var posted = await db.JarAllocationPostings
            .AsNoTracking()
            .Where(p => p.JarId != null && ids.Contains(p.JarId.Value) && p.JarAllocation.OwnerId == ownerId)
            .Select(p => p.JarId!.Value)
            .Distinct()
            .ToListAsync(cancellationToken);
        var spent = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.SavingsId != null && ids.Contains(i.SavingsId.Value)
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && (db.Transactions.Any(t => t.BudgetItemId == i.Id)
                            || db.TransactionSplits.Any(s => s.BudgetItemId == i.Id)))
            .Select(i => i.SavingsId!.Value)
            .Distinct()
            .ToListAsync(cancellationToken);
        return posted.Concat(spent).ToHashSet();
    }

    /// <summary>Whether <paramref name="jarId"/> has ever held money (see the class remarks).</summary>
    public static async Task<bool> HasHeldMoneyAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, CancellationToken cancellationToken)
        => (await EverHeldMoneyAsync(db, ownerId, new[] { jarId }, cancellationToken)).Count > 0;
}
