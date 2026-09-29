using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Accounts;

/// <summary>
/// P56: which transactions the household's budget and reports count. Money in a private account
/// counts only where its holder put it on a budget line (whole or a slice); the rest of it stays out
/// of every shared total for everyone, the holder included, so each login reads the same budget.
/// </summary>
public static class HouseholdMoney
{
    public static Expression<Func<Transaction, bool>> Counts(IApplicationDbContext db) =>
        t => t.BudgetItemId != null
             || t.Splits.Any(s => s.BudgetItemId != null)
             || !db.AccountPrivacies.Any(p => p.AccountId == t.AccountId);

    /// <summary>Which of these transactions' accounts are private, for slice-level checks done in memory.</summary>
    public static async Task<HashSet<Guid>> PrivateAccountIdsAsync(
        IApplicationDbContext db, IEnumerable<Transaction> transactions, CancellationToken ct)
    {
        var ids = transactions.Where(t => t.AccountId is not null).Select(t => t.AccountId!.Value).Distinct().ToList();
        if (ids.Count == 0)
        {
            return new HashSet<Guid>();
        }
        return (await db.AccountPrivacies
                .Where(p => ids.Contains(p.AccountId))
                .Select(p => p.AccountId)
                .ToListAsync(ct))
            .ToHashSet();
    }

    /// <summary>Whether a slice counts for the household: any slice of shared money, only a budgeted slice of private money.</summary>
    public static bool SliceCounts(Transaction t, TransactionSplit slice, HashSet<Guid> privateAccountIds) =>
        slice.BudgetItemId is not null || t.AccountId is not Guid accountId || !privateAccountIds.Contains(accountId);
}
