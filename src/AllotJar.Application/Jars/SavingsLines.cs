using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// The jar ↔ savings-line invariant, in one place: every Savings-kind budget line
/// references a real <see cref="Jar"/> (BudgetItems.SavingsId is an enforced FK to
/// Jars.Id), and a jar's monthly contribution is such a line. Jars are only created
/// through CreateJar with their designated account (rule 73); this helper only plants
/// an existing jar's line.
///
/// New rows are added through the DbSets with explicit FKs (never by mutating a
/// tracked month's navigation collections, which would attach the client-keyed
/// entities as Modified instead of Added). That also works for a month that is
/// itself still pending insert: ids are client-generated, so the FK values exist
/// before SaveChanges orders the inserts.
/// </summary>
public static class SavingsLines
{
    /// <summary>
    /// Appends <paramref name="jar"/>'s contribution line to the month's first Savings
    /// group, creating a "Savings" group when the month has none. The month's categories
    /// (with items) must be loaded/built on the instance; reading them is all this does.
    /// </summary>
    public static void AppendJarLine(IApplicationDbContext db, BudgetMonth month, Jar jar, decimal planned)
    {
        var savings = month.Categories
            .Where(c => c.Kind == CategoryKind.Savings)
            .OrderBy(c => c.DisplayOrder)
            .FirstOrDefault();
        if (savings is null)
        {
            savings = new BudgetCategory
            {
                BudgetMonthId = month.Id,
                Name = "Savings",
                Kind = CategoryKind.Savings,
                // Display order is contiguous per kind, and this is the first Savings group.
                DisplayOrder = 0,
            };
            db.BudgetCategories.Add(savings);
            // Also attach to the in-memory graph (safe: the explicit Add above pinned
            // the state) so a subsequent call for the same month finds the group.
            month.Categories.Add(savings);
        }

        var line = new BudgetItem
        {
            BudgetCategoryId = savings.Id,
            Name = jar.Name,
            PlannedAmount = planned,
            DisplayOrder = savings.Items.Count == 0 ? 0 : savings.Items.Max(i => i.DisplayOrder) + 1,
            SavingsId = jar.Id,
        };
        db.BudgetItems.Add(line);
        savings.Items.Add(line);
    }

    /// <summary>
    /// The first days of the months from <paramref name="from"/>'s month onward whose line for
    /// <paramref name="jarId"/> the user skipped (rule 60), so the planner leaves them at 0 and
    /// carries the plan on the other months (rule 61).
    /// </summary>
    public static async Task<HashSet<DateOnly>> SkippedMonthsAsync(
        IApplicationDbContext db, string ownerId, Guid jarId, DateOnly from, CancellationToken cancellationToken) =>
        (await SkippedMonthsByJarAsync(db, ownerId, new[] { jarId }, from, cancellationToken)).GetValueOrDefault(jarId) ?? new HashSet<DateOnly>();

    /// <summary>
    /// <see cref="SkippedMonthsAsync"/> for several jars at once: each jar's skipped months from
    /// <paramref name="from"/>'s month onward (a jar with none is absent), so month creation and
    /// the jar list plan around every skip, not only the current month's.
    /// </summary>
    public static async Task<Dictionary<Guid, HashSet<DateOnly>>> SkippedMonthsByJarAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> jarIds, DateOnly from, CancellationToken cancellationToken)
    {
        if (jarIds.Count == 0)
        {
            return new Dictionary<Guid, HashSet<DateOnly>>();
        }
        var fromKey = (from.Year * 12) + from.Month;
        var rows = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.SavingsId != null && jarIds.Contains(i.SavingsId.Value) && i.IsSkipped
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && (i.BudgetCategory.BudgetMonth.Year * 12) + i.BudgetCategory.BudgetMonth.Month >= fromKey)
            .Select(i => new { JarId = i.SavingsId!.Value, i.BudgetCategory.BudgetMonth.Year, i.BudgetCategory.BudgetMonth.Month })
            .ToListAsync(cancellationToken);
        return rows
            .GroupBy(r => r.JarId)
            .ToDictionary(g => g.Key, g => g.Select(r => new DateOnly(r.Year, r.Month, 1)).ToHashSet());
    }

    /// <summary>
    /// O3b: each jar's months from <paramref name="today"/>'s month on whose line carries an amount
    /// the user typed by hand (and did not skip), with what the month's lines plan. Every replant
    /// keeps them and plans the other months around them, as around a skipped month (P44). Only a
    /// line typed while its month was still a later one is marked (UpdateBudgetItem), so a figure
    /// typed for a later month keeps its amount once that month arrives, while one typed on the
    /// current month is replanted as before (P29; PR #305 review round 1, P2-1). A jar with none
    /// is absent.
    /// </summary>
    public static async Task<Dictionary<Guid, Dictionary<DateOnly, decimal>>> ByHandMonthsByJarAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> jarIds, DateOnly today, CancellationToken cancellationToken)
    {
        if (jarIds.Count == 0)
        {
            return new Dictionary<Guid, Dictionary<DateOnly, decimal>>();
        }
        var fromKey = (today.Year * 12) + today.Month;
        var rows = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.SavingsId != null && jarIds.Contains(i.SavingsId.Value)
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && (i.BudgetCategory.BudgetMonth.Year * 12) + i.BudgetCategory.BudgetMonth.Month >= fromKey)
            .Select(i => new { JarId = i.SavingsId!.Value, i.BudgetCategory.BudgetMonth.Year, i.BudgetCategory.BudgetMonth.Month, i.PlannedAmount, i.IsPlannedByHand, i.IsSkipped })
            .ToListAsync(cancellationToken);
        return rows
            .GroupBy(r => (r.JarId, Month: new DateOnly(r.Year, r.Month, 1)))
            .Where(g => g.Any(r => r.IsPlannedByHand) && !g.Any(r => r.IsSkipped))
            .GroupBy(g => g.Key.JarId)
            .ToDictionary(j => j.Key, j => j.ToDictionary(g => g.Key.Month, g => g.Sum(r => r.PlannedAmount)));
    }

    /// <summary>The months from the current one on whose line the user typed by hand (O3b), read from loaded lines.</summary>
    public static Dictionary<DateOnly, decimal> ByHandMonths(IEnumerable<(DateOnly Month, BudgetItem Line)> lines, DateOnly today)
    {
        var current = new DateOnly(today.Year, today.Month, 1);
        return lines
            .Where(l => l.Month >= current)
            .GroupBy(l => l.Month)
            .Where(g => g.Any(l => l.Line.IsPlannedByHand) && !g.Any(l => l.Line.IsSkipped))
            .ToDictionary(g => g.Key, g => g.Sum(l => l.Line.PlannedAmount));
    }

    /// <summary>
    /// Rules 27 and 55: stops the jar's planned contributions from the current month on. The
    /// current month's line is cut to what has actually gone into the jar since the month began
    /// (its remaining contribution is cancelled; rule 14's figures stay coherent), and each later
    /// month's line — a plan only — is removed, unless a transaction has been assigned to it, in
    /// which case it is kept at 0 so that history stays where it was. Past months, transactions
    /// and balances are never touched, and no money moves. The caller saves.
    /// </summary>
    /// <param name="keepSkipped">
    /// An archive (true) keeps each skipped line at 0 with its flag, so a restore replants around
    /// the months the user skipped (P44 over P40, his 1 Oct default; SC-P2-3). A completion never
    /// restarts (rule 55), so it has no skip to keep.
    /// </param>
    public static async Task CancelPlansAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly today, CancellationToken cancellationToken,
        bool keepSkipped = false)
    {
        var current = new DateOnly(today.Year, today.Month, 1);
        var lines = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .Where(i => i.SavingsId == jar.Id
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && (i.BudgetCategory.BudgetMonth.Year > today.Year
                            || (i.BudgetCategory.BudgetMonth.Year == today.Year && i.BudgetCategory.BudgetMonth.Month >= today.Month)))
            .ToListAsync(cancellationToken);
        if (lines.Count == 0)
        {
            return;
        }

        var ids = lines.Select(l => l.Id).ToList();
        var referenced = (await db.Transactions.AsNoTracking()
                .Where(t => t.BudgetItemId != null && ids.Contains(t.BudgetItemId.Value))
                .Select(t => t.BudgetItemId!.Value)
                .ToListAsync(cancellationToken))
            .Concat(await db.TransactionSplits.AsNoTracking()
                .Where(s => s.BudgetItemId != null && ids.Contains(s.BudgetItemId.Value))
                .Select(s => s.BudgetItemId!.Value)
                .ToListAsync(cancellationToken))
            .ToHashSet();

        // Rule 14: what went into the jar since the month began — its postings, so money that
        // left the jar this month is not netted off (the same figure the jar's card reads).
        var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        var contributed = ledger.ContributionsBetween(current, today).GetValueOrDefault(jar.Id);
        var currentSeen = false;
        foreach (var line in lines.OrderBy(l => l.BudgetCategory.BudgetMonth.Year).ThenBy(l => l.BudgetCategory.BudgetMonth.Month))
        {
            var month = new DateOnly(line.BudgetCategory.BudgetMonth.Year, line.BudgetCategory.BudgetMonth.Month, 1);
            // A stopped jar's plan is cancelled, a hand-typed amount included (O3b).
            line.IsPlannedByHand = false;
            if (keepSkipped && line.IsSkipped)
            {
                // The user's skip outlives the archive: the line stays at 0, flagged.
                line.PlannedAmount = 0m;
            }
            else if (month == current)
            {
                // One line carries what was contributed; a duplicate (a copied month that already
                // had one) drops to 0.
                line.PlannedAmount = currentSeen ? 0m : contributed;
                currentSeen = true;
                line.IsSkipped = false;
            }
            else if (referenced.Contains(line.Id))
            {
                line.PlannedAmount = 0m;
                line.IsSkipped = false;
            }
            else
            {
                db.BudgetItems.Remove(line);
            }
        }
    }
}
