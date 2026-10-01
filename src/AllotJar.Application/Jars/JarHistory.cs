using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// A jar's definition over time (P49; rules 46, 48): an edit that changes the definition is dated,
/// so a month that is over is judged against the target, deadline and plan the jar had at its end
/// — editing a jar later rewrites neither that month's plan (rule 46 replants only the current and
/// later months) nor its status. Cycles are not revisions: a Recurring jar's cycles close as
/// <see cref="JarCycle"/> rows, and the cycle open at a date is read from them.
/// </summary>
public static class JarHistory
{
    /// <summary>
    /// Records an edit made on <paramref name="today"/> that changed the jar's definition. The
    /// jar's first recorded edit also stores the definition it replaces (<paramref name="replaced"/>,
    /// captured before the edit) as applying to every earlier date. A second edit the same day
    /// overwrites the day's revision: a month is judged against the definition at its end. The
    /// caller saves.
    /// </summary>
    public static async Task RecordEditAsync(
        IApplicationDbContext db, Jar jar, JarRevision replaced, DateOnly today, CancellationToken cancellationToken)
    {
        var revisions = await db.JarRevisions
            .Where(r => r.JarId == jar.Id)
            .ToListAsync(cancellationToken);
        if (revisions.Count == 0)
        {
            replaced.EffectiveFrom = DateOnly.MinValue;
            db.JarRevisions.Add(replaced);
        }

        var sameDay = revisions.FirstOrDefault(r => r.EffectiveFrom == today);
        if (sameDay is null)
        {
            db.JarRevisions.Add(JarRevision.Of(jar, today));
        }
        else
        {
            sameDay.Record(jar);
        }
    }

    /// <summary>
    /// <paramref name="jar"/> as archived or live on <paramref name="date"/> (P2-19): a copy
    /// marked archived from the start of the <see cref="JarArchivePeriod"/> covering the date,
    /// when the jar was archived then and has been restored since; otherwise the jar's own archive
    /// (<see cref="JarSchedule.IsArchivedOn"/> reads its day). A detached copy; the row is not changed.
    /// </summary>
    public static Jar ArchiveOn(Jar jar, IEnumerable<JarArchivePeriod>? periods, DateOnly date)
    {
        var then = jar.Copy();
        if (periods?.Where(p => p.ArchivedOn <= date && date < p.RestoredOn).MinBy(p => p.ArchivedOn) is { } period)
        {
            then.IsArchived = true;
            then.ArchivedOn = period.ArchivedOn;
        }
        return then;
    }

    /// <summary>
    /// The recorded Recurring cycle that was still open at the end of <paramref name="date"/> and
    /// has closed since: the earliest one not closed by then. A cycle paid on time counts as closed
    /// from its payment (rule 22, <see cref="JarCycle.ClosedForHistoryOn"/>), even when the user
    /// marked it paid later.
    /// </summary>
    public static JarCycle? CycleOpenOn(IReadOnlyCollection<JarCycle>? cycles, DateOnly date) =>
        cycles?.Where(c => c.ClosedForHistoryOn > date).OrderBy(c => c.Deadline).FirstOrDefault();

    /// <summary>
    /// Each of <paramref name="jars"/> as defined, and archived or live, at the end of
    /// <paramref name="date"/> (a day that is over): <see cref="DefinitionOn"/> from its latest
    /// revision on or before the date and its recorded cycles, then <see cref="ArchiveOn"/> — the
    /// definition <see cref="JarFigures"/> judges a month that is over against, so the planner
    /// plants a back-filled month toward the same one (SC-P2-4). Detached copies.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, Jar>> DefinitionsOnAsync(
        IApplicationDbContext db, IReadOnlyCollection<Jar> jars, DateOnly date, CancellationToken cancellationToken)
    {
        var ids = jars.Select(j => j.Id).ToList();
        var revisions = (await db.JarRevisions
                .AsNoTracking()
                .Where(r => ids.Contains(r.JarId) && r.EffectiveFrom <= date)
                .ToListAsync(cancellationToken))
            .GroupBy(r => r.JarId)
            .ToDictionary(g => g.Key, g => g.MaxBy(r => r.EffectiveFrom)!);
        var cycles = (await db.JarCycles
                .AsNoTracking()
                .Where(c => ids.Contains(c.JarId))
                .ToListAsync(cancellationToken))
            .GroupBy(c => c.JarId)
            .ToDictionary(g => g.Key, g => g.ToList());
        var periods = await JarFigures.ArchivePeriodsAsync(db, ids, cancellationToken);
        return jars.ToDictionary(
            j => j.Id,
            j => ArchiveOn(DefinitionOn(j, revisions.GetValueOrDefault(j.Id), cycles.GetValueOrDefault(j.Id), date),
                periods.GetValueOrDefault(j.Id), date));
    }

    /// <summary>
    /// The jar as it was defined at the end of <paramref name="date"/> (a month that is over): the
    /// latest revision dated on or before it, or the jar's own row when it has none. For a
    /// Recurring jar, the cycle that was still open then and has closed since keeps its own
    /// deadline (the closed cycle's record) — and its target when the jar has no revision, since
    /// a revision holds the target the jar had on the date while a cycle records the one it
    /// closed with. With no such cycle, the open cycle then is the one the definition was saving
    /// toward, moved past every cycle that had closed by the date (a rollover settled later is
    /// dated on its deadline, a cycle paid on time on its payment). A detached copy; the row is not
    /// changed.
    /// </summary>
    public static Jar DefinitionOn(Jar jar, JarRevision? revision, IReadOnlyCollection<JarCycle>? cycles, DateOnly date)
    {
        var then = revision is null ? jar.Copy() : revision.ApplyTo(jar);
        if (then.Kind != JarKind.Recurring || cycles is null)
        {
            return then;
        }

        var cycleThen = CycleOpenOn(cycles, date);
        if (cycleThen is not null)
        {
            then.CycleDeadline = cycleThen.Deadline;
            if (revision is null)
            {
                then.TargetAmount = cycleThen.TargetAmount;
            }
            return then;
        }

        var due = then.CycleDeadline ?? then.TargetDate;
        while (due is { } d && cycles.Any(c => c.Deadline == d && c.ClosedForHistoryOn <= date))
        {
            due = JarSchedule.NextCycleDeadline(then, d);
        }
        then.CycleDeadline = due;
        return then;
    }
}
