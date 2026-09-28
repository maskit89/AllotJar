using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A dated copy of a <see cref="Jar"/>'s definition — the fields that decide its plan and its
/// status — so a month that is over is judged against the definition the jar had at its end, not
/// today's (P49; rules 46, 48). Written only when an edit changes the definition: the first edit
/// also records the definition it replaces, effective from <see cref="DateOnly.MinValue"/>. A jar
/// never edited has no rows, and its own row is its definition on every date. The live definition
/// stays on <see cref="Jar"/>; nothing here is read for the current month or a later one.
/// </summary>
public class JarRevision : BaseEntity
{
    public Guid JarId { get; set; }
    public Jar Jar { get; set; } = null!;

    /// <summary>The first day this definition applied (the UTC date of the edit); <see cref="DateOnly.MinValue"/> for the definition the jar had before its first edit.</summary>
    public DateOnly EffectiveFrom { get; set; }

    public JarKind Kind { get; set; }
    public decimal TargetAmount { get; set; }
    public DateOnly? TargetDate { get; set; }

    /// <summary>A Recurring jar's open cycle when the revision was written (<see cref="Jar.CycleDeadline"/>); cycles that close later are <see cref="JarCycle"/> rows.</summary>
    public DateOnly? CycleDeadline { get; set; }

    public AccrualMethod Accrual { get; set; }
    public decimal? MonthlyContribution { get; set; }
    public bool IncludeDeadlineMonth { get; set; }
    public int? RecurMonths { get; set; }

    /// <summary>The jar's definition as it stands, effective from <paramref name="effectiveFrom"/>.</summary>
    public static JarRevision Of(Jar jar, DateOnly effectiveFrom)
    {
        var revision = new JarRevision { JarId = jar.Id, EffectiveFrom = effectiveFrom };
        revision.Record(jar);
        return revision;
    }

    /// <summary>Overwrites this revision's definition with <paramref name="jar"/>'s (a second edit the same day).</summary>
    public void Record(Jar jar)
    {
        Kind = jar.Kind;
        TargetAmount = jar.TargetAmount;
        TargetDate = jar.TargetDate;
        CycleDeadline = jar.CycleDeadline;
        Accrual = jar.Accrual;
        MonthlyContribution = jar.MonthlyContribution;
        IncludeDeadlineMonth = jar.IncludeDeadlineMonth;
        RecurMonths = jar.RecurMonths;
    }

    /// <summary>A detached copy of <paramref name="jar"/> (identity, account, archive and completion as they are today) carrying this revision's definition. Never attached to a context.</summary>
    public Jar ApplyTo(Jar jar)
    {
        var then = jar.Copy();
        then.Kind = Kind;
        then.TargetAmount = TargetAmount;
        then.TargetDate = TargetDate;
        then.CycleDeadline = CycleDeadline;
        then.Accrual = Accrual;
        then.MonthlyContribution = MonthlyContribution;
        then.IncludeDeadlineMonth = IncludeDeadlineMonth;
        then.RecurMonths = RecurMonths;
        return then;
    }
}
