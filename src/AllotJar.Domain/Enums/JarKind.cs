namespace AllotJar.Domain.Enums;

/// <summary>
/// What a <see cref="Entities.Jar"/> is for — the single control that configures the
/// jar's lifecycle. A <see cref="Recurring"/> jar saves toward a due date and repeats:
/// each cycle closes — paid, funded on time, or missed and dismissed — and the jar moves
/// on to the next deadline (insurance, road tax, holiday; W03, rules 19–24).
/// A <see cref="Goal"/> is saved toward once and then done (kitchen, sofa, wedding).
/// The cycle length lives in <see cref="Entities.Jar.RecurMonths"/> (null for Goals) and
/// the open cycle's deadline in <see cref="Entities.Jar.CycleDeadline"/>.
/// </summary>
public enum JarKind
{
    /// <summary>Refills each cycle — a smoothed recurring cost or annual sinking fund.</summary>
    Recurring = 0,

    /// <summary>A one-off savings target; once funded, it's done.</summary>
    Goal = 1
}
