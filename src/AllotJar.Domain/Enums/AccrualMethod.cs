namespace AllotJar.Domain.Enums;

/// <summary>
/// How a <see cref="Entities.Jar"/>'s monthly contribution is planned (rules 16–17): a jar
/// with a target saves either toward a deadline or at a fixed monthly amount; an ongoing
/// jar (no target) saves a fixed monthly amount. The earlier spreadsheet-derived modes
/// (StraightLine 0, ProportionalPool 2, DailyRate 3) were retired on 27 September 2026
/// (HANDOVER O6); the JarSchedules migration remaps any stored row to
/// <see cref="TargetByDate"/>.
/// </summary>
public enum AccrualMethod
{
    /// <summary>
    /// The remaining target is spread over the months up to the deadline (rules 12–13, 35–36):
    /// equal amounts with the rounding remainder in the final month, recalculated from the
    /// actual balance at each month start. Required for a Recurring jar.
    /// </summary>
    TargetByDate = 1,

    /// <summary>
    /// A fixed amount chosen by the user is planned every month (rule 16). With a target the
    /// final contribution is capped at what remains and planning stops once the target is
    /// actually reached (rule 18); the months still needed are shown as an estimate (rule 58).
    /// </summary>
    FixedMonthly = 2,
}
