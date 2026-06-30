namespace ZeroBudget.Domain.Enums;

/// <summary>
/// What a <see cref="Entities.Jar"/> is for — the single control that configures the
/// jar's lifecycle. A <see cref="Recurring"/> jar refills every cycle (insurance, road
/// tax, holiday, gifts); a <see cref="Goal"/> is saved toward once and then done
/// (kitchen, sofa, wedding). <see cref="Entities.Jar.RecurAnnually"/> is derived from
/// this (Recurring ⇒ renews, Goal ⇒ does not), so the two never disagree.
/// </summary>
public enum JarKind
{
    /// <summary>Refills each cycle — a smoothed recurring cost or annual sinking fund.</summary>
    Recurring = 0,

    /// <summary>A one-off savings target; once funded, it's done.</summary>
    Goal = 1
}
