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
            if (await JudgeWaitingAsync(db, ownerId, today, jarId, cancellationToken))
            {
                await db.SaveChangesAsync(cancellationToken);
            }
            return false;
        }
        var judged = await JudgeWaitingAsync(db, ownerId, today, jarId, cancellationToken);

        var changed = false;
        // Settling moves no money: one load of the ledger serves every deadline and replant (P3-10).
        var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        foreach (var jar in due)
        {
            var advanced = false;
            while (jar.CycleDeadline is { } deadline && deadline <= today)
            {
                var held = ledger.At(deadline.AddDays(-1)).BalanceOf(jar.Id);
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
                await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken, ledger);
                changed = true;
            }
        }

        if (changed || judged)
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        return changed;
    }

    /// <summary>
    /// <see cref="SettleAsync"/> as a read runs it (the jars, a schedule preview, a skip preview).
    /// The settle saves on the side of a page load, so a concurrent write that got there first (two
    /// page loads settling the same cycle, which collide on its unique index, or an edit of the
    /// jar or of one of the lines the settle replants, which moves its row version, D11) is not
    /// this read's failure: the cycle is treated as settled by that write, this context's unsaved
    /// settle is dropped, and the read goes on from the database as it now stands.
    /// </summary>
    /// <returns>True when a cycle rolled forward, or may have (the settle lost to a concurrent
    /// write): the caller reads the jar again.</returns>
    public static async Task<bool> SettleOnReadAsync(
        IApplicationDbContext db, string ownerId, DateOnly today, CancellationToken cancellationToken, Guid? jarId = null)
    {
        try
        {
            return await SettleAsync(db, ownerId, today, cancellationToken, jarId);
        }
        catch (DbUpdateException ex) when (ex is DbUpdateConcurrencyException || IsCollision(ex))
        {
            db.DiscardChanges();
            return true;
        }
    }

    /// <summary>
    /// True when a save failed on one of the jar cycles' unique indexes ((JarId, Deadline) or the
    /// payment). Matched by index name in the provider's message, as the import's reference check is.
    /// </summary>
    public static bool IsCollision(DbUpdateException ex) =>
        ex.InnerException?.Message.Contains("IX_JarCycles_", StringComparison.Ordinal) == true;

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
        // Closing a cycle moves no money: one load serves the deadline's balance and the replant.
        var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        var cycle = new JarCycle
        {
            OwnerId = ownerId,
            JarId = jar.Id,
            Deadline = deadline,
            TargetAmount = jar.TargetAmount,
            Outcome = outcome,
            BalanceAtDeadline = deadline <= today ? ledger.At(deadline.AddDays(-1)).BalanceOf(jar.Id) : null,
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
        await JarPlanner.ReplantAsync(db, ownerId, jar, today, 0m, cancellationToken, ledger);
        return cycle;
    }

    /// <summary>
    /// The payments that fulfilled cycles (rule 83) are being deleted: the bill is unpaid again
    /// (MG-P2-2; default until Christopher answers, deleting it reopens the cycle). When the cycle
    /// is the jar's latest closed one and the jar still plans toward the cycle after it, the cycle
    /// becomes the open one again: its row goes and <see cref="Jar.CycleDeadline"/> returns to its
    /// deadline, so the next read settles it afresh (rolled forward Funded if the money was there
    /// the day before, otherwise Deadline missed until the user acts, rules 20–21). An older cycle,
    /// or one whose jar has moved on since (archived, completed, its date changed), keeps its row
    /// and is judged as the rollover would have judged it — Funded when, without this payment, the
    /// jar held its target the day before the deadline, otherwise Missed — with no payment, so
    /// another can be linked to it, closed on its deadline. One whose deadline is still ahead
    /// (paid early) is judged when the deadline arrives (<see cref="SettleAsync"/>).
    /// The jar's draw of the payment goes with the transaction itself. Returns the jars whose open
    /// cycle came back, to be replanted once the deletion is saved. The caller saves.
    /// </summary>
    public static async Task<IReadOnlyList<Jar>> ReopenPaidByAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyCollection<Guid> paymentIds, DateOnly today, CancellationToken cancellationToken)
    {
        var paid = await db.JarCycles
            .Include(c => c.Jar)
            .Where(c => c.PaymentTransactionId != null && paymentIds.Contains(c.PaymentTransactionId.Value))
            .ToListAsync(cancellationToken);
        var reopened = new List<Jar>();
        JarLedgerSource? withoutPayment = null;
        foreach (var cycle in paid)
        {
            var jar = cycle.Jar;
            var later = await db.JarCycles.AnyAsync(c => c.JarId == jar.Id && c.Deadline > cycle.Deadline, cancellationToken);
            if (!later && JarSchedule.IsPlanning(jar) && jar.Kind == JarKind.Recurring
                && jar.CycleDeadline is { } open && open == JarSchedule.NextCycleDeadline(jar, cycle.Deadline))
            {
                db.JarCycles.Remove(cycle);
                jar.CycleDeadline = cycle.Deadline;
                reopened.Add(jar);
                continue;
            }

            // Without its payment the cycle closed on its deadline, not on the day it was marked
            // paid (#301 review P3-1).
            cycle.ClosedOn = cycle.Deadline;
            if (cycle.Deadline > today)
            {
                // Paid ahead, and its deadline has not come: nothing can be judged yet. It waits
                // unjudged (no balance) and SettleAsync judges it when the deadline arrives.
                cycle.BalanceAtDeadline = null;
                cycle.Outcome = JarCycleOutcome.Funded;
            }
            else
            {
                withoutPayment ??= await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken, excludeTransactionIds: paymentIds);
                Judge(cycle, withoutPayment);
            }
            cycle.PaymentTransactionId = null;
            cycle.PaymentTransaction = null;
            cycle.PaidOn = null;
            cycle.PaidAmount = null;
        }
        return reopened;
    }

    /// <summary>Judges a cycle with no payment as the rollover would: Funded when the jar held its target the day before the deadline, otherwise Missed.</summary>
    private static void Judge(JarCycle cycle, JarLedgerSource ledger)
    {
        cycle.BalanceAtDeadline = ledger.At(cycle.Deadline.AddDays(-1)).BalanceOf(cycle.JarId);
        cycle.Outcome = cycle.BalanceAtDeadline is { } held && held >= cycle.TargetAmount
            ? JarCycleOutcome.Funded
            : JarCycleOutcome.Missed;
    }

    /// <summary>
    /// Cycles whose payment was deleted before their deadline (<see cref="ReopenPaidByAsync"/>)
    /// are judged once the deadline has arrived. A rollover always records the balance it judged,
    /// so an unpaid Funded cycle with none is one of these. The caller saves.
    /// </summary>
    private static async Task<bool> JudgeWaitingAsync(
        IApplicationDbContext db, string ownerId, DateOnly today, Guid? jarId, CancellationToken cancellationToken)
    {
        var waiting = await db.JarCycles
            .Where(c => c.OwnerId == ownerId && c.Outcome == JarCycleOutcome.Funded && c.PaymentTransactionId == null
                        && c.BalanceAtDeadline == null && c.Deadline <= today && (jarId == null || c.JarId == jarId))
            .ToListAsync(cancellationToken);
        if (waiting.Count == 0)
        {
            return false;
        }
        var ledger = await JarLedgerReader.LoadAsync(db, ownerId, cancellationToken);
        foreach (var cycle in waiting)
        {
            Judge(cycle, ledger);
        }
        return true;
    }

    /// <summary>
    /// How a missed cycle closes without a payment (rule 20 dismissed, rule 57): FundedLate when
    /// the jar holds its target <paramref name="balanceNow"/>, otherwise Missed.
    /// </summary>
    public static JarCycleOutcome UnpaidCloseOutcome(Jar jar, decimal? balanceNow) =>
        balanceNow is { } balance && balance >= jar.TargetAmount ? JarCycleOutcome.FundedLate : JarCycleOutcome.Missed;

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
}
