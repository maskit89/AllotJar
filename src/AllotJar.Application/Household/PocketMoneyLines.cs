using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Household;

/// <summary>
/// A person's pocket-money budget lines are the expense lines that carry their id (rule 53):
/// the sync stamps <see cref="BudgetItem.MemberId"/> on every line it creates or adopts, a
/// rename follows the person, and archiving stops the planned amounts from next month on while
/// leaving every recorded payment where it is (rule 54).
/// </summary>
public static class PocketMoneyLines
{
    /// <summary>The calendar current month, the one rule 54's keep-or-cancel question is about.</summary>
    public static (int Year, int Month) CurrentMonth()
    {
        var today = DateTime.UtcNow;
        return (today.Year, today.Month);
    }

    /// <summary>
    /// Each active or archived person's pocket-money figures for the calendar current month:
    /// planned, paid so far (the line's actuals) and the remainder. People without a line are
    /// absent; so is everyone when the month has no budget yet.
    /// </summary>
    public static async Task<IReadOnlyDictionary<Guid, MemberPocketMoneyDto>> ForCurrentMonthAsync(
        IApplicationDbContext db, string ownerId, CancellationToken cancellationToken)
    {
        var (year, month) = CurrentMonth();
        var budget = await db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstOrDefaultAsync(
                m => m.OwnerId == ownerId && m.Year == year && m.Month == month, cancellationToken);
        if (budget is null)
        {
            return new Dictionary<Guid, MemberPocketMoneyDto>();
        }

        var lines = budget.Categories
            .Where(c => c.Kind == CategoryKind.Expense)
            .SelectMany(c => c.Items)
            .Where(i => i.MemberId is not null)
            .ToList();
        if (lines.Count == 0)
        {
            return new Dictionary<Guid, MemberPocketMoneyDto>();
        }

        await BudgetActuals.ApplyAsync(db, ownerId, budget, cancellationToken);

        // One line per person is the sync's invariant; a legacy duplicate is summed rather than
        // hidden so the figure the archive dialog shows is what the month plans.
        return lines
            .GroupBy(i => i.MemberId!.Value)
            .ToDictionary(
                g => g.Key,
                g =>
                {
                    var planned = g.Sum(i => i.PlannedAmount);
                    var paid = g.Sum(i => i.ActualAmount);
                    return new MemberPocketMoneyDto(planned, paid, Math.Max(planned - paid, 0m));
                });
    }

    /// <summary>Renames the person's pocket-money lines in every month (rule 53).</summary>
    public static async Task RenameAsync(
        IApplicationDbContext db, string ownerId, Guid memberId, string name, CancellationToken cancellationToken)
    {
        var lines = await db.BudgetItems
            .Where(i => i.MemberId == memberId
                        && i.BudgetCategory.Kind == CategoryKind.Expense
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId)
            .ToListAsync(cancellationToken);
        foreach (var line in lines)
        {
            line.Name = name;
        }
    }

    /// <summary>
    /// Rule 54 on archive: every future month's line for the person is removed when nothing has
    /// been recorded against it, otherwise its planned amount is cut to what was paid; the current
    /// month's line is left alone unless <paramref name="cancelCurrentMonth"/>, in which case its
    /// planned amount is cut to what was paid so far. Past months and recorded payments are never
    /// touched. Changes are tracked on <paramref name="db"/>; the caller saves.
    /// </summary>
    public static async Task StopFromNextMonthAsync(
        IApplicationDbContext db, string ownerId, Guid memberId, bool cancelCurrentMonth,
        CancellationToken cancellationToken)
    {
        var (year, month) = CurrentMonth();
        var currentIndex = year * 12 + month;

        var lines = await db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Where(i => i.MemberId == memberId
                        && i.BudgetCategory.Kind == CategoryKind.Expense
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && i.BudgetCategory.BudgetMonth.Year * 12 + i.BudgetCategory.BudgetMonth.Month >= currentIndex)
            .ToListAsync(cancellationToken);
        if (lines.Count == 0)
        {
            return;
        }

        var lineIds = lines.Select(i => i.Id).ToList();
        var paidByLine = await PaidByLineAsync(db, ownerId, lineIds, cancellationToken);
        var referenced = await ReferencedLineIdsAsync(db, lineIds, cancellationToken);

        foreach (var line in lines)
        {
            var monthIndex = line.BudgetCategory.BudgetMonth.Year * 12 + line.BudgetCategory.BudgetMonth.Month;
            var isCurrent = monthIndex == currentIndex;
            if (isCurrent && !cancelCurrentMonth)
            {
                continue;
            }

            var paid = paidByLine.GetValueOrDefault(line.Id);
            if (!isCurrent && !referenced.Contains(line.Id))
            {
                // Nothing recorded against a future line: it simply goes.
                db.BudgetItems.Remove(line);
                continue;
            }

            // Cancelling the remainder keeps the line, so its recorded payments stay attached and
            // the month still shows what was paid out (rule 54).
            line.PlannedAmount = Math.Min(line.PlannedAmount, paid);
        }
    }

    /// <summary>Expense money already recorded against each line, at the transaction's rate.</summary>
    private static async Task<Dictionary<Guid, decimal>> PaidByLineAsync(
        IApplicationDbContext db, string ownerId, List<Guid> lineIds, CancellationToken cancellationToken)
    {
        var whole = await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && t.Type == TransactionType.Expense
                        && t.BudgetItemId != null
                        && lineIds.Contains(t.BudgetItemId.Value))
            .GroupBy(t => t.BudgetItemId!.Value)
            .Select(g => new { LineId = g.Key, Total = g.Sum(t => t.Amount * t.ExchangeRate) })
            .ToListAsync(cancellationToken);
        var slices = await (
            from s in db.TransactionSplits
            join t in db.Transactions on s.TransactionId equals t.Id
            where t.OwnerId == ownerId
                  && t.Type == TransactionType.Expense
                  && s.BudgetItemId != null
                  && lineIds.Contains(s.BudgetItemId.Value)
            select new { LineId = s.BudgetItemId!.Value, Total = s.Amount * t.ExchangeRate })
            .ToListAsync(cancellationToken);

        return whole.Select(w => (w.LineId, w.Total))
            .Concat(slices.Select(s => (s.LineId, s.Total)))
            .GroupBy(x => x.LineId)
            .ToDictionary(g => g.Key, g => g.Sum(x => x.Total));
    }

    /// <summary>Lines any transaction or split slice still points at (of any kind, even pending).</summary>
    private static async Task<HashSet<Guid>> ReferencedLineIdsAsync(
        IApplicationDbContext db, List<Guid> lineIds, CancellationToken cancellationToken)
    {
        var fromTransactions = await db.Transactions
            .Where(t => t.BudgetItemId != null && lineIds.Contains(t.BudgetItemId.Value))
            .Select(t => t.BudgetItemId!.Value)
            .Distinct()
            .ToListAsync(cancellationToken);
        var fromSplits = await db.TransactionSplits
            .Where(s => s.BudgetItemId != null && lineIds.Contains(s.BudgetItemId.Value))
            .Select(s => s.BudgetItemId!.Value)
            .Distinct()
            .ToListAsync(cancellationToken);
        return fromTransactions.Concat(fromSplits).ToHashSet();
    }
}
