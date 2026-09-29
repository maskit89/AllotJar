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

        // P53: a savings account private to another login is not there for this caller, but it is
        // not missing either. Those people are named so the preview can say why their share can't
        // move and the commit can refuse before touching anything, instead of treating them as
        // having no savings account.
        var unseen = members
            .Where(m => m.PersonalSavingsAccountId is Guid sid && !savingsBalances.ContainsKey(sid))
            .Select(m => m.PersonalSavingsAccountId!.Value)
            .ToList();
        var privateElsewhere = unseen.Count == 0
            ? new HashSet<Guid>()
            : (await db.AccountPrivacies.Where(p => unseen.Contains(p.AccountId)).Select(p => p.AccountId).ToListAsync(ct))
                .ToHashSet();
        var privateSavings = members
            .Where(m => m.PersonalSavingsAccountId is Guid sid && privateElsewhere.Contains(sid))
            .Select(m => m.Id)
            .ToHashSet();

        // Rule 28: the engine's income is the month's budgeted income and nothing else — each
        // person's attributed lines plus an equal share of the unattributed lines. The saved
        // per-person defaults never supply or top up the pool; a month with no budget has none.
        var budgetIncome = await MemberIncome.SharesAsync(db, ownerId, year, month, members, ct);

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
                var netIncome = budgetIncome.Income.GetValueOrDefault(m.Id);
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
            UnattributedIncome: budgetIncome.Unattributed,
            IncomeFromBudget: true,
            PrivateSavings: privateSavings);
    }

    /// <summary>
    /// Actual balance today of each member's personal-savings account, read through the shared
    /// dated account ledger and used to tilt a balance-aware savings split. Excludes
    /// <em>this month's</em> allocation transfers (allocation key prefix
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
            exclude: t => t.AllocationKey is not null && t.AllocationKey.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

        return accounts.ToDictionary(a => a.Id, a => views[a.Id].Balance);
    }
}

public record AllocationPlan(
    AllocationResult Result,
    AllocationProfile? Profile,
    decimal EnvelopesTotal,
    decimal JarsTotal,
    decimal UnattributedIncome = 0m,
    bool IncomeFromBudget = false,
    IReadOnlySet<Guid>? PrivateSavings = null);
