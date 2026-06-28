using Microsoft.EntityFrameworkCore;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Domain.Entities;
using ZeroBudget.Domain.Enums;
using ZeroBudget.Domain.Services;

namespace ZeroBudget.Application.Allocation;

/// <summary>
/// Shared read-side for preview and commit: loads the owner's allocation profile and
/// active members, resolves the month's shared-obligation totals from the budget
/// (Expense-category planned → envelopes, Savings-category planned → jars), and
/// runs the pure <see cref="IncomeAllocator"/>. No writes.
/// </summary>
public static class AllocationPlanner
{
    public static async Task<AllocationPlan> PlanAsync(
        IApplicationDbContext db, string ownerId, int year, int month, Guid? profileId, CancellationToken ct)
    {
        var profile = await db.AllocationProfiles
            .AsNoTracking()
            .Include(p => p.Rules)
            .Where(p => p.OwnerId == ownerId && (profileId == null || p.Id == profileId))
            .OrderBy(p => p.Name)
            .FirstOrDefaultAsync(ct);

        var members = await db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == ownerId && !m.IsArchived)
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(ct);

        // Shared-obligation totals derived live from the month's budget. Categories flagged
        // ExcludeFromAllocation (e.g. "Personal Savings") are allocation *outputs*, not costs,
        // so they're left out — otherwise the surplus would be subtracted from the pool twice.
        var totals = await (
            from i in db.BudgetItems
            join c in db.BudgetCategories on i.BudgetCategoryId equals c.Id
            join bm in db.BudgetMonths on c.BudgetMonthId equals bm.Id
            where bm.OwnerId == ownerId && bm.Year == year && bm.Month == month
                  && !c.ExcludeFromAllocation
                  && (c.Kind == CategoryKind.Expense || c.Kind == CategoryKind.Savings)
            group i by c.Kind into g
            select new { Kind = g.Key, Total = g.Sum(x => x.PlannedAmount) })
            .ToListAsync(ct);

        var envelopes = totals.Where(t => t.Kind == CategoryKind.Expense).Sum(t => t.Total);
        var funds = totals.Where(t => t.Kind == CategoryKind.Savings).Sum(t => t.Total);

        var savingsBalances = await SavingsBalancesAsync(db, ownerId, members, year, month, ct);

        var allocMembers = members
            .Select(m => new AllocationMember(
                m.Id, m.Name, m.NetMonthlyIncome, m.PersonalSavingsAccountId,
                SavingsBalance: m.PersonalSavingsAccountId is Guid sid && savingsBalances.TryGetValue(sid, out var bal) ? bal : 0m))
            .ToList();

        var ruleInputs = (profile?.Rules ?? Enumerable.Empty<AllocationRule>())
            .OrderBy(r => r.Order)
            .Select(r => new AllocationRuleInput(
                r.Order, r.Type, r.Split, r.FixedAmountPerMember,
                ResolvedTotal: r.Type switch
                {
                    AllocationRuleType.FundEnvelopes => envelopes,
                    AllocationRuleType.FundJars => funds,
                    _ => 0m,
                }))
            .ToList();

        var result = IncomeAllocator.Compute(allocMembers, ruleInputs, profile?.BalanceLeanPercent ?? 25);
        return new AllocationPlan(result, profile, envelopes, funds);
    }

    /// <summary>
    /// Current balance of each member's personal-savings account, used to tilt a balance-aware
    /// savings split. Excludes <em>this month's</em> allocation transfers (BankReference prefix
    /// <c>alloc:{year}-{month}:</c>) so preview and a re-run commit both see the pre-allocation
    /// balance — keeping the tilt stable and the commit idempotent.
    /// </summary>
    private static async Task<Dictionary<Guid, decimal>> SavingsBalancesAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyList<HouseholdMember> members, int year, int month, CancellationToken ct)
    {
        var savingsIds = members
            .Where(m => m.PersonalSavingsAccountId.HasValue)
            .Select(m => m.PersonalSavingsAccountId!.Value)
            .Distinct()
            .ToList();
        if (savingsIds.Count == 0)
        {
            return new Dictionary<Guid, decimal>();
        }

        var accounts = await db.Accounts
            .AsNoTracking()
            .Where(a => a.OwnerId == ownerId && savingsIds.Contains(a.Id))
            .Select(a => new { a.Id, a.OpeningBalance })
            .ToListAsync(ct);

        var nets = await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && t.AccountId != null && savingsIds.Contains(t.AccountId.Value)
                        && (t.Type == TransactionType.Income || t.Type == TransactionType.Expense))
            .GroupBy(t => new { AccountId = t.AccountId!.Value, t.Type })
            .Select(g => new { g.Key.AccountId, g.Key.Type, Total = g.Sum(x => x.Amount) })
            .ToListAsync(ct);

        var prefix = $"alloc:{year}-{month}:";
        var transfers = await db.Transactions
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Transfer
                        && (t.BankReference == null || !t.BankReference.StartsWith(prefix))
                        && ((t.AccountId != null && savingsIds.Contains(t.AccountId.Value))
                            || (t.TransferAccountId != null && savingsIds.Contains(t.TransferAccountId.Value))))
            .Select(t => new { t.AccountId, t.TransferAccountId, t.Amount })
            .ToListAsync(ct);

        return accounts.ToDictionary(
            a => a.Id,
            a => a.OpeningBalance
                 + nets.Where(n => n.AccountId == a.Id && n.Type == TransactionType.Income).Sum(n => n.Total)
                 - nets.Where(n => n.AccountId == a.Id && n.Type == TransactionType.Expense).Sum(n => n.Total)
                 - transfers.Where(t => t.AccountId == a.Id).Sum(t => t.Amount)
                 + transfers.Where(t => t.TransferAccountId == a.Id).Sum(t => t.Amount));
    }
}

public record AllocationPlan(AllocationResult Result, AllocationProfile? Profile, decimal EnvelopesTotal, decimal JarsTotal);
