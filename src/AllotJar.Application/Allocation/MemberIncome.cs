using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Allocation;

/// <summary>
/// Per-member income for a month, read from that month's budgeted income lines and nothing
/// else (rule 28): the lines attributed to a person are that person's income, and the lines
/// attributed to nobody are the household's, shared equally among the active people. The
/// saved per-person default (<see cref="HouseholdMember.NetMonthlyIncome"/>) is a helper for
/// filling in a new budget and never supplies or tops up this pool. PLANNED amounts by design:
/// the allocation engine is a planning tool and already resolves envelopes and jars from the
/// plan; a mid-month run on actuals would see half a salary.
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
        var hasBudget = await db.BudgetMonths
            .AsNoTracking()
            .AnyAsync(bm => bm.OwnerId == ownerId && bm.Year == year && bm.Month == month, ct);

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

        return new MemberIncomeBreakdown(byMember, unattributed, byMember.Values.Any(v => v > 0m), hasBudget);
    }

    /// <summary>
    /// Each active member's income for the month, the way every People and Allocation figure
    /// must see it (rules 28/29): the member's attributed lines plus an equal share of the
    /// unattributed lines (the last member in <paramref name="members"/> absorbs the rounding
    /// remainder, the IncomeAllocator.Split convention). A month with no budget yields zero for
    /// everyone — never the saved defaults.
    /// </summary>
    public static async Task<MemberIncomeShares> SharesAsync(
        IApplicationDbContext db,
        string ownerId,
        int year,
        int month,
        IReadOnlyList<HouseholdMember> members,
        CancellationToken ct)
    {
        var active = members.Where(m => !m.IsArchived).ToList();
        var breakdown = await ForMonthAsync(db, ownerId, year, month, active.Select(m => m.Id).ToList(), ct);

        var income = new Dictionary<Guid, decimal>();
        var equalShare = active.Count > 0 ? Math.Round(breakdown.Unattributed / active.Count, 4) : 0m;
        for (var i = 0; i < active.Count; i++)
        {
            var share = i == active.Count - 1
                ? breakdown.Unattributed - equalShare * (active.Count - 1)
                : equalShare;
            income[active[i].Id] = breakdown.ByMember.GetValueOrDefault(active[i].Id) + share;
        }
        foreach (var archived in members.Where(m => m.IsArchived))
        {
            income[archived.Id] = 0m;
        }
        return new MemberIncomeShares(income, breakdown.Unattributed, breakdown.HasBudget);
    }
}

/// <param name="ByMember">Planned income attributed to each active member.</param>
/// <param name="Unattributed">Planned income with no (active) member — whole-household.</param>
/// <param name="HasAttributedIncome">True when at least one active member has attributed income &gt; 0.</param>
/// <param name="HasBudget">True when the month has a budget at all; without one every figure is zero.</param>
public record MemberIncomeBreakdown(
    IReadOnlyDictionary<Guid, decimal> ByMember,
    decimal Unattributed,
    bool HasAttributedIncome,
    bool HasBudget = true);

/// <param name="Income">Each member's month income (attributed plus equal share of unattributed); archived members 0.</param>
/// <param name="Unattributed">The unattributed planned income that was shared out.</param>
/// <param name="HasBudget">False when the month has no budget (every figure is then zero).</param>
public record MemberIncomeShares(IReadOnlyDictionary<Guid, decimal> Income, decimal Unattributed, bool HasBudget)
{
    public decimal Total => Income.Values.Sum();

    /// <summary>The member's share of the household's month income (0–1), 0 when there is no income.</summary>
    public decimal ShareOf(Guid memberId) =>
        Total > 0m ? Math.Round(Income.GetValueOrDefault(memberId) / Total, 4, MidpointRounding.AwayFromZero) : 0m;
}
