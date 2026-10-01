using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Household;

/// <summary>
/// A person's pocket-money lines: the Expense-group budget lines linked to them by
/// <see cref="BudgetItem.MemberId"/> (rule 53 — the link is the person's permanent id, never
/// their display name; the pocket-money sync is the only writer of that link on an expense
/// line, income lines carry it for "who earns"). Rule 54 reads and cancels them when the person
/// is archived: a cancelled line keeps what was already paid against it (its planned amount
/// drops to the paid amount, never below) and is removed only when nothing was ever recorded on
/// it, so no actual balance or payment changes.
/// </summary>
public static class PocketMoneyLines
{
    /// <summary>
    /// The person's pocket-money lines in every month from <paramref name="fromYear"/>/<paramref name="fromMonth"/>
    /// onward (oldest first), with what is planned and what has been paid so far — base currency,
    /// pending-rate rows left out, the same derivation the Budget page shows.
    /// </summary>
    public static async Task<IReadOnlyList<PocketMoneyMonth>> ReadFromAsync(
        IApplicationDbContext db, string ownerId, Guid memberId, int fromYear, int fromMonth, CancellationToken ct)
    {
        var months = await db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .Where(m => m.OwnerId == ownerId
                        && (m.Year > fromYear || (m.Year == fromYear && m.Month >= fromMonth))
                        && m.Categories.Any(c => c.Kind == CategoryKind.Expense && c.Items.Any(i => i.MemberId == memberId)))
            .OrderBy(m => m.Year)
                .ThenBy(m => m.Month)
            .ToListAsync(ct);

        var result = new List<PocketMoneyMonth>(months.Count);
        foreach (var month in months)
        {
            // Read-side actuals on a detached graph: nothing here is saved.
            await BudgetActuals.ApplyAsync(db, ownerId, month, ct);
            var lines = month.Categories
                .Where(c => c.Kind == CategoryKind.Expense)
                .SelectMany(c => c.Items)
                .Where(i => i.MemberId == memberId)
                // A refund lands on the line it is linked to (P19), possibly one with less spent
                // than came back: the line's net is then below zero, but nothing was paid out of
                // it, never a negative payment (RP-P2-1).
                .Select(i => new PocketMoneyLine(i.Id, i.PlannedAmount, Math.Max(0m, i.ActualAmount)))
                .ToList();
            result.Add(new PocketMoneyMonth(month.Id, month.Year, month.Month, lines));
        }
        return result;
    }

    /// <summary>
    /// Cancels the remaining planned pocket money on the tracked <paramref name="month"/>'s lines for
    /// the person: a line nothing was ever recorded against is removed; a line with payments keeps
    /// them, its planned amount dropping to what was paid (an overspent line is left as it is).
    /// Returns the planned amount cancelled. The caller saves.
    /// </summary>
    public static async Task<decimal> CancelAsync(
        IApplicationDbContext db,
        BudgetMonth month,
        Guid memberId,
        IReadOnlyDictionary<Guid, decimal> paidByLine,
        CancellationToken ct)
    {
        var cancelled = 0m;
        foreach (var category in month.Categories.Where(c => c.Kind == CategoryKind.Expense))
        {
            foreach (var line in category.Items.Where(i => i.MemberId == memberId).ToList())
            {
                var recorded = await db.Transactions.AnyAsync(t => t.BudgetItemId == line.Id, ct)
                               || await db.TransactionSplits.AnyAsync(s => s.BudgetItemId == line.Id, ct);
                if (!recorded)
                {
                    cancelled += line.PlannedAmount;
                    category.Items.Remove(line);
                    db.BudgetItems.Remove(line);
                    continue;
                }

                // Never below zero: a planned amount can't be negative (RP-P2-1).
                var paid = Math.Max(0m, paidByLine.GetValueOrDefault(line.Id));
                if (line.PlannedAmount > paid)
                {
                    cancelled += line.PlannedAmount - paid;
                    line.PlannedAmount = paid;
                }
            }
        }
        return cancelled;
    }
}

/// <summary>One month's pocket-money lines for a person, as read by <see cref="PocketMoneyLines.ReadFromAsync"/>.</summary>
public record PocketMoneyMonth(Guid MonthId, int Year, int Month, IReadOnlyList<PocketMoneyLine> Lines)
{
    public decimal Planned => Lines.Sum(l => l.Planned);
    public decimal Paid => Lines.Sum(l => l.Paid);

    /// <summary>What is still planned beyond what was paid; an overspent line contributes nothing.</summary>
    public decimal Remaining => Lines.Sum(l => Math.Max(l.Planned - l.Paid, 0m));
}

public record PocketMoneyLine(Guid Id, decimal Planned, decimal Paid);
