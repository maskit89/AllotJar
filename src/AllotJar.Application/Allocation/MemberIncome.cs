using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation;

/// <summary>
/// Per-member income derived from the viewed month's budgeted income lines — the
/// budget-as-source-of-truth half of per-person income. PLANNED amounts by design:
/// the engine is a planning tool and already resolves envelopes/jars from planned;
/// a mid-month run on actuals would see half a salary.
/// </summary>
public static class MemberIncome
{
    /// <param name="activeMemberIds">Active (non-archived) members: income attributed to
    /// anyone else — e.g. a member archived after attribution — folds into
    /// <see cref="MemberIncomeBreakdown.Unattributed"/>.</param>
    public static async Task<MemberIncomeBreakdown> ForMonthAsync(
        IApplicationDbContext db,
        string ownerId,
        int year,
        int month,
        IReadOnlyCollection<Guid> activeMemberIds,
        CancellationToken ct)
    {
        var totals = await (
            from i in db.BudgetItems
            join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
            join bm in db.BudgetMonths on c.BudgetMonthId equals bm.Id
            where bm.OwnerId == ownerId && bm.Year == year && bm.Month == month
                  && c.Kind == CategoryKind.Income
            group i by i.MemberId into g
            select new { MemberId = g.Key, Total = g.Sum(x => x.PlannedAmount) })
            .ToListAsync(ct);

        var byMember = new Dictionary<Guid, decimal>();
        var unattributed = 0m;
        foreach (var t in totals)
        {
            if (t.MemberId is Guid mid && activeMemberIds.Contains(mid))
            {
                byMember[mid] = t.Total;
            }
            else
            {
                unattributed += t.Total;
            }
        }

        return new MemberIncomeBreakdown(byMember, unattributed, byMember.Values.Any(v => v > 0m));
    }
}

/// <param name="ByMember">Planned income attributed to each active member.</param>
/// <param name="Unattributed">Planned income with no (active) member — whole-household.</param>
/// <param name="HasAttributedIncome">True when at least one active member has attributed
/// income &gt; 0 — the switch that makes the budget the engine's income source.</param>
public record MemberIncomeBreakdown(
    IReadOnlyDictionary<Guid, decimal> ByMember,
    decimal Unattributed,
    bool HasAttributedIncome);
