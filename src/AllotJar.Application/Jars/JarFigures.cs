using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Jars;

/// <summary>
/// The one read path for <see cref="JarDto"/>s: the ledger as of the month's balance date and as
/// of the end of the month before it (rule 14's "contributed this month"), plus the month's stored
/// savings lines (its plans, and whether the month was skipped — W04), each jar's last closed
/// cycle (W03) and whether it ever held money (rule 84). Callers settle the
/// cycles first (<see cref="JarCycles.SettleAsync"/>) where a deadline may have arrived. Every handler that returns a jar goes through here so the card
/// never changes between the write that returned it and the next load.
/// <para>
/// W05 (rule 48): <c>month</c> selects the budget month the figures belong to. A past month's
/// balances are read as of its last day, excluding everything after it; the current month and a
/// later one read as of <c>asOf</c> (today), so a month that has not begun shows today's balance
/// with nothing contributed yet. The plan is that month's own line — or nothing, for a month that
/// is over and has no line for the jar; a month that has not begun and has no line yet is planned
/// from that month. A month that is over is judged against the definition the jar had at its end
/// (<see cref="JarHistory.DefinitionOn"/>: the latest revision on or before it, and a Recurring
/// cycle open then and closed since), archived or live as it was then (P2-19).
/// </para>
/// </summary>
public static class JarFigures
{
    public static async Task<IReadOnlyList<JarDto>> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Jar> jars,
        DateOnly asOf,
        CancellationToken cancellationToken,
        DateOnly? month = null,
        JarLedgerSource? ledger = null)
    {
        if (jars.Count == 0)
        {
            return Array.Empty<JarDto>();
        }

        // The month whose figures are wanted (any day in it), and the date its balances are read
        // as of: a past month ends on its last day (rule 48); the current month and a later one
        // read as of today — the future is not read, so a month that has not begun contributes
        // nothing yet and today's balance is what it holds.
        var monthStart = month is { } m ? new DateOnly(m.Year, m.Month, 1) : new DateOnly(asOf.Year, asOf.Month, 1);
        var monthEnd = monthStart.AddMonths(1).AddDays(-1);
        // A month that is over is history (rule 46): its figures are what they were at its end.
        var isOver = monthEnd < asOf;
        var balanceDate = isOver ? monthEnd : asOf;
        var dayBefore = monthStart.AddDays(-1);
        if (dayBefore > balanceDate)
        {
            dayBefore = balanceDate;
        }

        // Actual money only (rule 1): each jar's allocations in its account as of the date, and
        // as the month began (the same snapshot when the month has not begun: nothing went in yet),
        // from one load of the ledger (P3-6).
        ledger ??= await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        var now = ledger.At(balanceDate);
        var before = dayBefore == balanceDate ? now : ledger.At(dayBefore);

        var ids = jars.Select(j => j.Id).ToList();
        // This month's stored lines: the plan they carry, and whether the user skipped the month
        // (rule 60) — one flag per jar, however many lines a copied month left it.
        var storedLines = (await db.BudgetItems
                .AsNoTracking()
                .Where(i => i.SavingsId != null && ids.Contains(i.SavingsId.Value)
                            && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                            && i.BudgetCategory.BudgetMonth.Year == monthStart.Year
                            && i.BudgetCategory.BudgetMonth.Month == monthStart.Month)
                .Select(i => new { JarId = i.SavingsId!.Value, i.PlannedAmount, i.IsSkipped })
                .ToListAsync(cancellationToken))
            .GroupBy(i => i.JarId)
            .ToDictionary(g => g.Key, g => (Planned: g.Sum(i => i.PlannedAmount), Skipped: g.Any(i => i.IsSkipped)));

        // The months the user skipped from this one on (rule 60), so the card's horizon follows
        // the same plan the Savings lines carry (rule 61).
        var skippedMonths = await SavingsLines.SkippedMonthsByJarAsync(db, ownerId, ids, monthStart, cancellationToken);

        // Rule 84: a jar that never held money may be deleted outright; the card offers it.
        var heldMoney = await JarUsage.EverHeldMoneyAsync(db, ownerId, ids, cancellationToken);

        // Each Recurring jar's cycles (W03): the most recently closed one for the card's history
        // line, and — for a month that is over — the cycle that was still open at the balance
        // date (P49: a past month's status is what it was then, not today's cycle re-judged).
        var cycles = (await db.JarCycles
                .AsNoTracking()
                .Include(c => c.PaymentTransaction)
                .Where(c => ids.Contains(c.JarId))
                .ToListAsync(cancellationToken))
            .GroupBy(c => c.JarId)
            .ToDictionary(g => g.Key, g => g.ToList());
        // The Recurring cycle still open at the balance date of a month that is over (P49; a cycle
        // paid on time counts as closed from its payment, rule 22). A cycle after it cannot have
        // closed by then, whatever its record says, so the history line never shows one.
        JarCycle? CycleOpenThen(Guid jarId) => isOver ? JarHistory.CycleOpenOn(cycles.GetValueOrDefault(jarId), balanceDate) : null;
        JarCycle? LastCycleOf(Guid jarId, JarCycle? openThen) => cycles.GetValueOrDefault(jarId)?
            .Where(c => !isOver || (c.ClosedForHistoryOn <= balanceDate && (openThen is null || c.Deadline < openThen.Deadline)))
            .OrderByDescending(c => c.Deadline).ThenByDescending(c => c.CreatedUtc)
            .FirstOrDefault();

        // A month that is over is judged against the definition the jar had at its end (P49): the
        // latest revision dated on or before it (JarHistory). Today's row serves the current month,
        // a later one, and a jar never edited.
        var revisions = isOver
            ? (await db.JarRevisions
                    .AsNoTracking()
                    .Where(r => ids.Contains(r.JarId) && r.EffectiveFrom <= balanceDate)
                    .ToListAsync(cancellationToken))
                .GroupBy(r => r.JarId)
                .ToDictionary(g => g.Key, g => g.MaxBy(r => r.EffectiveFrom)!)
            : new Dictionary<Guid, JarRevision>();
        // ... and archived or live as it was then (P2-19: a jar restored since still reads the
        // months it spent archived as archived).
        var archivePeriods = isOver ? await ArchivePeriodsAsync(db, ids, cancellationToken) : null;
        Jar DefinitionOf(Jar jar) => isOver
            ? JarHistory.ArchiveOn(
                JarHistory.DefinitionOn(jar, revisions.GetValueOrDefault(jar.Id), cycles.GetValueOrDefault(jar.Id), balanceDate),
                archivePeriods!.GetValueOrDefault(jar.Id), balanceDate)
            : jar;

        return jars
            .Select(j => DefinitionOf(j).ToDto(
                now.BalanceOf(j.Id),
                before.BalanceOf(j.Id),
                // A month that is over planned what its line says, or nothing: a jar with no line
                // there (created later, or never planted) is not given a plan after the fact.
                storedLines.TryGetValue(j.Id, out var line) ? line.Planned : isOver ? 0m : null,
                balanceDate,
                LastCycleOf(j.Id, CycleOpenThen(j.Id)),
                month: monthStart,
                skippedThisMonth: storedLines.TryGetValue(j.Id, out var flags) && flags.Skipped,
                canDelete: !heldMoney.Contains(j.Id),
                skippedMonths: skippedMonths.GetValueOrDefault(j.Id)))
            .ToList();
    }

    public static async Task<JarDto> ReadOneAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly asOf, CancellationToken cancellationToken)
        => (await ReadAsync(db, ownerId, new[] { jar }, asOf, cancellationToken))[0];

    /// <summary>The stretches each jar spent archived and was restored from (P2-19).</summary>
    internal static async Task<Dictionary<Guid, List<JarArchivePeriod>>> ArchivePeriodsAsync(
        IApplicationDbContext db, IReadOnlyCollection<Guid> jarIds, CancellationToken cancellationToken) =>
        (await db.JarArchivePeriods
            .AsNoTracking()
            .Where(p => jarIds.Contains(p.JarId))
            .ToListAsync(cancellationToken))
        .GroupBy(p => p.JarId)
        .ToDictionary(g => g.Key, g => g.ToList());
}
