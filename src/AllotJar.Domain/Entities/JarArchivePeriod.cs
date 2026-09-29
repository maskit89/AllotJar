using AllotJar.Domain.Common;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A stretch a <see cref="Jar"/> spent archived and has since been restored from (W05 follow-up,
/// P2-19): from <see cref="ArchivedOn"/> up to the day before <see cref="RestoredOn"/>. The live
/// archive is <see cref="Jar.IsArchived"/> with <see cref="Jar.ArchivedOn"/>; restoring a jar
/// clears those and records the period here, so a month that ended while the jar was archived
/// still reads it as archived (rule 27, P49) instead of as if it had been live all along.
/// </summary>
public class JarArchivePeriod : BaseEntity
{
    public Guid JarId { get; set; }
    public Jar Jar { get; set; } = null!;

    /// <summary>The first day the jar was archived.</summary>
    public DateOnly ArchivedOn { get; set; }

    /// <summary>The day it was restored: live again from this day.</summary>
    public DateOnly RestoredOn { get; set; }
}
