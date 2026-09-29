using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars;

/// <summary>
/// The lifecycle of a Recurring jar's cycles (W03; rules 19–24, 57, 83). A jar's open cycle is
/// <see cref="Jar.CycleDeadline"/>; closing it writes a <see cref="JarCycle"/> and advances the
/// jar to the next deadline, and every close replants the current and later months' Savings
/// lines toward that deadline from the balance the jar actually holds (rule 19: whatever is
/// left carries forward and reduces what the next cycle needs). Nothing here moves money or
/// records a payment (rules 20–21, 23).
/// </summary>
public static class JarCycles
{
    /// <summary>
    /// Rule 21, settled lazily: there is no scheduler, so the rollover a deadline's arrival
    /// triggers is applied the first time the jars are read or planned after it. Every active
    /// Recurring jar whose open cycle's deadline is at or before <paramref name="today"/> and
    /// whose target was held at the end of the day before it (the deadline day is never a
    /// contribution day, rule 82) closes that cycle as <see cref="JarCycleOutcome.Funded"/> and
    /// moves on — repeatedly, if several cycles have passed unseen. A cycle that was short stays
    /// open: that is the persistent <b>Deadline missed</b> state (rule 20), which only the user
    /// ends by marking the cycle paid or dismissing it. Saves when anything changed.
    /// </summary>
    /// <param name="jarId">Settle only this jar; null settles every jar of the owner.</param>
    /// <returns>True when at least one cycle rolled forward.</returns>
    public static async Task<bool> SettleAsync(
        IApplicationDbContext db, string ownerId, DateOnly today, CancellationToken cancellationToken, Guid? jarId = null)
    {
        var due = await db.Jars
            .Where(j => j.OwnerId == ownerId && !j.IsArchived && j.Kind == JarKind.Recurring
                        && j.CycleDeadline != null && j.CycleDeadline <= today
                        && (jarId == null || j.Id == jarId))
            .ToListAsync(cancellationToken);
        if (due.Count == 0)
        {
            return false;
        }

        var changed = false;
        foreach (var jar in due)
        {
            var advanced = false;
            while (jar.CycleDeadline is { } deadline && deadline <= today)
            {
                var held = await BalanceBeforeAsync(db, ownerId, jar, deadline, cancellationToken);
                if (held is null || held < jar.TargetAmount)
                {
                    // Short (or unknowable) when the money had to be there: Deadline missed,
                    // until the user says otherwise.
                    break;
                }
                db.JarCycles.Add(new JarCycle
                {
                    OwnerId = ownerId,
                    JarId = jar.Id,
                    Deadline = deadline,
                    TargetAmount = jar.TargetAmount,
                    Outcome = JarCycleOutcome.Funded,
                    BalanceAtDeadline = held,
                    ClosedOn = deadline,
                    CreatedUtc = DateTime.UtcNow,
                });
                jar.CycleDeadline = JarSchedule.NextCycleDeadline(jar, deadline);
                advanced = true;
            }
            if (advanced)
            {
                await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken);
                changed = true;
            }
        }

        if (changed)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        return changed;
    }

    /// <summary>
    /// Closes the jar's open cycle with <paramref name="outcome"/> and advances it to the next
    /// deadline, replanting the current and later months from the balance it holds. The caller
    /// saves. For a paid cycle (rule 83) <paramref name="payment"/> is the transaction the user
    /// chose; the cycle keeps its date and base-currency amount of its own.
    /// </summary>
    public static async Task<JarCycle> CloseOpenCycleAsync(
        IApplicationDbContext db, string ownerId, Jar jar, JarCycleOutcome outcome, Transaction? payment,
        DateOnly today, CancellationToken cancellationToken)
    {
        var deadline = jar.CycleDeadline
            ?? throw new InvalidOperationException($"{jar.Name} has no open cycle.");
        var cycle = new JarCycle
        {
            OwnerId = ownerId,
            JarId = jar.Id,
            Deadline = deadline,
            TargetAmount = jar.TargetAmount,
            Outcome = outcome,
            BalanceAtDeadline = deadline <= today ? await BalanceBeforeAsync(db, ownerId, jar, deadline, cancellationToken) : null,
            ClosedOn = today,
            CreatedUtc = DateTime.UtcNow,
        };
        if (payment is not null)
        {
            Link(cycle, payment);
        }
        db.JarCycles.Add(cycle);
        jar.CycleDeadline = JarSchedule.NextCycleDeadline(jar, deadline);
        // The next cycle starts from what is actually left (rules 19, 23): the bill that just
        // left the jar counts now, this month included (JarPlanner.PlanningBalance).
        await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken);
        return cycle;
    }

    /// <summary>Records <paramref name="payment"/> as the one that fulfilled <paramref name="cycle"/> (rule 83).</summary>
    public static void Link(JarCycle cycle, Transaction payment)
    {
        cycle.Outcome = JarCycleOutcome.Paid;
        cycle.PaymentTransactionId = payment.Id;
        cycle.PaymentTransaction = payment;
        cycle.PaidOn = payment.Date;
        cycle.PaidAmount = payment.BudgetAmount ?? payment.Amount;
    }

    /// <summary>
    /// The anchor and open-cycle deadline a create or edit leaves a jar with. A Recurring jar's
    /// form shows its open cycle's date; sending that date (or the stored anchor) back unchanged
    /// keeps both, so a plain rename never resets a cycle that has already advanced. Any other
    /// date is a deliberate change: it becomes the new anchor and the open cycle. Goals have no
    /// cycle.
    /// </summary>
    public static (DateOnly? Anchor, DateOnly? CycleDeadline) DeadlinesFor(Jar? existing, JarKind kind, DateOnly? requested)
    {
        if (kind != JarKind.Recurring)
        {
            return (requested, null);
        }
        if (existing is { Kind: JarKind.Recurring, CycleDeadline: { } open }
            && requested is { } date && (date == open || date == existing.TargetDate))
        {
            return (existing.TargetDate, open);
        }
        return (requested, requested);
    }

    /// <summary>The jar's balance at the end of the day before <paramref name="deadline"/>; null when unavailable (rule 67).</summary>
    public static async Task<decimal?> BalanceBeforeAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly deadline, CancellationToken cancellationToken)
    {
        var snapshot = await JarLedgerReader.ReadAsync(db, ownerId, deadline.AddDays(-1), cancellationToken);
        return snapshot.BalanceOf(jar.Id);
    }
}
