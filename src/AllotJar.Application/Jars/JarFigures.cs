using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Jars;

/// <summary>
/// The one read path for <see cref="JarDto"/>s: the ledger as of the date and as of the end
/// of the previous month (rule 14's "contributed this month"), plus the month's stored
/// savings lines (its plans, and whether the month was skipped — W04), each jar's last closed
/// cycle (W03) and whether it ever held money (rule 84). Callers settle the
/// cycles first (<see cref="JarCycles.SettleAsync"/>) where a deadline may have arrived. Every handler that returns a jar goes through here so the card
/// never changes between the write that returned it and the next load.
/// </summary>
public static class JarFigures
{
    public static async Task<IReadOnlyList<JarDto>> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Jar> jars,
        DateOnly asOf,
        CancellationToken cancellationToken,
        IReadOnlyCollection<Guid>? accountIds = null)
    {
        if (jars.Count == 0)
        {
            return Array.Empty<JarDto>();
        }

        // Actual money only (rule 1): each jar's allocations in its account as of the date, and
        // as the month began.
        var monthStart = new DateOnly(asOf.Year, asOf.Month, 1);
        var now = await JarLedgerReader.ReadAsync(db, ownerId, asOf, cancellationToken, accountIds);
        var before = await JarLedgerReader.ReadAsync(db, ownerId, monthStart.AddDays(-1), cancellationToken, accountIds);

        var ids = jars.Select(j => j.Id).ToList();
        // This month's stored lines: the plan they carry, and whether the user skipped the month
        // (rule 60) — one flag per jar, however many lines a copied month left it.
        var storedLines = (await db.BudgetItems
                .AsNoTracking()
                .Where(i => i.SavingsId != null && ids.Contains(i.SavingsId.Value)
                            && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                            && i.BudgetCategory.BudgetMonth.Year == asOf.Year
                            && i.BudgetCategory.BudgetMonth.Month == asOf.Month)
                .Select(i => new { JarId = i.SavingsId!.Value, i.PlannedAmount, i.IsSkipped })
                .ToListAsync(cancellationToken))
            .GroupBy(i => i.JarId)
            .ToDictionary(g => g.Key, g => (Planned: g.Sum(i => i.PlannedAmount), Skipped: g.Any(i => i.IsSkipped)));

        // The months the user skipped from this one on (rule 60), so the card's horizon follows
        // the same plan the Savings lines carry (rule 61).
        var skippedMonths = await SavingsLines.SkippedMonthsByJarAsync(db, ownerId, ids, monthStart, cancellationToken);

        // Rule 84: a jar that never held money may be deleted outright; the card offers it.
        var heldMoney = await JarUsage.EverHeldMoneyAsync(db, ownerId, ids, cancellationToken);

        // Each Recurring jar's most recently closed cycle (W03), for the card's history line.
        var lastCycles = (await db.JarCycles
                .AsNoTracking()
                .Include(c => c.PaymentTransaction)
                .Where(c => ids.Contains(c.JarId))
                .ToListAsync(cancellationToken))
            .GroupBy(c => c.JarId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(c => c.Deadline).ThenByDescending(c => c.CreatedUtc).First());

        return jars
            .Select(j => j.ToDto(
                now.BalanceOf(j.Id),
                before.BalanceOf(j.Id),
                storedLines.TryGetValue(j.Id, out var line) ? line.Planned : null,
                asOf,
                lastCycles.GetValueOrDefault(j.Id),
                skippedThisMonth: storedLines.TryGetValue(j.Id, out var flags) && flags.Skipped,
                canDelete: !heldMoney.Contains(j.Id),
                skippedMonths: skippedMonths.GetValueOrDefault(j.Id)))
            .ToList();
    }

    public static async Task<JarDto> ReadOneAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly asOf, CancellationToken cancellationToken)
        => (await ReadAsync(db, ownerId, new[] { jar }, asOf, cancellationToken, new[] { jar.FundingAccountId }))[0];
}
