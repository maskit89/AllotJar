using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Allocation;

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

        // Per-member income precedence: when the month's budget attributes income lines to
        // people, those PLANNED sums are the engine's income source (the budget is the single
        // source of truth); unattributed income is shared equally (last member absorbs the
        // rounding remainder, the IncomeAllocator.Split convention). A month with no attributed
        // lines falls back to the static NetMonthlyIncome — exact pre-attribution behavior.
        var budgetIncome = await MemberIncome.ForMonthAsync(
            db, ownerId, year, month, members.Select(m => m.Id).ToList(), ct);
        var equalShares = new Dictionary<Guid, decimal>();
        if (budgetIncome.HasAttributedIncome && members.Count > 0 && budgetIncome.Unattributed != 0m)
        {
            var share = Math.Round(budgetIncome.Unattributed / members.Count, 4);
            for (var i = 0; i < members.Count; i++)
            {
                equalShares[members[i].Id] = i == members.Count - 1
                    ? budgetIncome.Unattributed - share * (members.Count - 1)
                    : share;
            }
        }

        var allocMembers = members
            .Select(m =>
            {
                // Only keep the savings-account link when the account still exists and belongs to
                // this household. PersonalSavingsAccountId is a soft hint with no FK, so a deleted
                // (or foreign) account leaves it dangling — and savingsBalances only ever contains
                // owned, existing accounts. Passing a dangling id through to the commit would write a
                // broken Transfer.TransferAccountId FK and crash the whole allocation on SQL Server.
                var savingsId = m.PersonalSavingsAccountId is Guid sid && savingsBalances.ContainsKey(sid)
                    ? (Guid?)sid
                    : null;
                var netIncome = budgetIncome.HasAttributedIncome
                    ? budgetIncome.ByMember.GetValueOrDefault(m.Id) + equalShares.GetValueOrDefault(m.Id)
                    : m.NetMonthlyIncome;
                var savingsBalance = savingsId is Guid vid ? savingsBalances[vid] : null;
                return new AllocationMember(
                    m.Id, m.Name, netIncome, savingsId,
                    SavingsBalance: savingsBalance ?? 0m,
                    SavingsBalanceAvailable: savingsBalance.HasValue);
            })
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
        return new AllocationPlan(
            result, profile, envelopes, funds,
            UnattributedIncome: budgetIncome.HasAttributedIncome ? budgetIncome.Unattributed : 0m,
            IncomeFromBudget: budgetIncome.HasAttributedIncome);
    }

    /// <summary>
    /// Actual balance today of each member's personal-savings account, read through the shared
    /// dated account ledger and used to tilt a balance-aware savings split. Excludes
    /// <em>this month's</em> allocation transfers (BankReference prefix
    /// <c>alloc:{year}-{month}:</c>) so preview and a re-run commit both see the pre-allocation
    /// balance — keeping the tilt stable and the commit idempotent. A null value means the
    /// balance is unavailable (no opening date); the tilt treats it as zero, but it is reported
    /// as unknown rather than displayed as money.
    /// </summary>
    private static async Task<Dictionary<Guid, decimal?>> SavingsBalancesAsync(
        IApplicationDbContext db, string ownerId, IReadOnlyList<HouseholdMember> members, int year, int month, CancellationToken ct)
    {
        var savingsIds = members
            .Where(m => m.PersonalSavingsAccountId.HasValue)
            .Select(m => m.PersonalSavingsAccountId!.Value)
            .Distinct()
            .ToList();
        if (savingsIds.Count == 0)
        {
            return new Dictionary<Guid, decimal?>();
        }

        var accounts = await db.Accounts
            .AsNoTracking()
            .Where(a => a.OwnerId == ownerId && savingsIds.Contains(a.Id))
            .ToListAsync(ct);

        var prefix = $"alloc:{year}-{month}:";
        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await Accounts.AccountLedgerReader.ReadAsync(
            db, ownerId, accounts, asOf, ct,
            exclude: t => t.BankReference is not null && t.BankReference.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

        return accounts.ToDictionary(a => a.Id, a => views[a.Id].Balance);
    }
}

public record AllocationPlan(
    AllocationResult Result,
    AllocationProfile? Profile,
    decimal EnvelopesTotal,
    decimal JarsTotal,
    decimal UnattributedIncome = 0m,
    bool IncomeFromBudget = false);
