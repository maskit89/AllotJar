using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// A lightweight, behind-the-scenes categorizer. When a transaction is logged without a budget
/// line, it inherits the line the user last used for the same description (payee) — but resolved
/// to the line IN THE TRANSACTION'S OWN MONTH, never a prior month's line. Budget lines are
/// month-scoped rows, so replaying a concrete prior-month line id onto a later transaction would
/// mis-bucket it (a July spend landing on June's actuals). Instead we learn a payee's recurring
/// line by its stable cross-month identity and look that identity up in the transaction's month;
/// if that month has no matching line, the payee is left unassigned. Zero-configuration — there
/// are no user-managed rules. Used by manual create, statement import, and the import preview.
/// </summary>
public static partial class AutoCategorizer
{
    public static async Task<int> ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Transaction> transactions,
        CancellationToken cancellationToken)
    {
        // Only unassigned transactions with a usable description are candidates.
        var candidates = transactions
            .Where(t => t.BudgetItemId is null && NormalizeDescription(t.Payee).Length > 0)
            .ToList();
        if (candidates.Count == 0)
        {
            return 0;
        }

        // Never let a candidate match against itself (the batch may already be tracked).
        var candidateIds = candidates.Select(t => t.Id).ToHashSet();
        var requests = candidates
            .Select(t => (t.Payee, t.Date.Year, t.Date.Month))
            .ToList();

        var resolved = await ResolveLinesAsync(db, ownerId, candidateIds, requests, cancellationToken);
        if (resolved.Count == 0)
        {
            return 0;
        }

        var assigned = 0;
        foreach (var tx in candidates)
        {
            if (resolved.TryGetValue((NormalizeDescription(tx.Payee), tx.Date.Year, tx.Date.Month), out var itemId))
            {
                tx.BudgetItemId = itemId;
                assigned++;
            }
        }

        return assigned;
    }

    /// <summary>
    /// For each requested (payee, year, month), resolve the budget line to suggest/assign: the
    /// recurring line the user last used for that payee, looked up IN THE REQUEST'S OWN MONTH.
    /// A line's cross-month identity is its fund <c>SavingsId</c>, else (category kind, category
    /// name, line name) — all of which the monthly rollover copies forward. If the request's month
    /// has no matching line, the payee is left unresolved (rather than borrowing another month's
    /// line, which mis-buckets the budget). Shared by <see cref="ApplyAsync"/> and the import
    /// preview so the suggestion always matches what a commit would actually do.
    /// </summary>
    public static async Task<IReadOnlyDictionary<(string PayeeKey, int Year, int Month), Guid>> ResolveLinesAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlySet<Guid> excludeTransactionIds,
        IReadOnlyCollection<(string Payee, int Year, int Month)> requests,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<(string, int, int), Guid>();

        var payeeKeys = requests
            .Select(r => NormalizeDescription(r.Payee))
            .Where(k => k.Length > 0)
            .ToHashSet();
        if (payeeKeys.Count == 0)
        {
            return result;
        }

        // payee -> the recurring-line identity of the most recent prior categorized transaction
        // with that payee (most recent Date wins).
        var prior = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == ownerId
                        && t.BudgetItemId != null
                        && !excludeTransactionIds.Contains(t.Id))
            .OrderByDescending(t => t.Date)
            .ThenByDescending(t => t.Id)
            .Select(t => new
            {
                t.Payee,
                Kind = t.BudgetItem!.BudgetCategory.Kind,
                CategoryName = t.BudgetItem.BudgetCategory.Name,
                ItemName = t.BudgetItem.Name,
                t.BudgetItem.SavingsId,
            })
            .ToListAsync(cancellationToken);

        var identityByPayee = new Dictionary<string, string>();
        foreach (var p in prior)
        {
            var key = NormalizeDescription(p.Payee);
            if (key.Length > 0 && payeeKeys.Contains(key) && !identityByPayee.ContainsKey(key))
            {
                identityByPayee[key] = LineIdentity(p.Kind, p.CategoryName, p.ItemName, p.SavingsId);
            }
        }
        if (identityByPayee.Count == 0)
        {
            return result;
        }

        // Index the lines of every requested month by their identity. (EF can't filter on a set of
        // (year, month) tuples, so query the years×months superset and drop the cross-terms.)
        var months = requests.Select(r => (r.Year, r.Month)).Distinct().ToHashSet();
        var years = months.Select(m => m.Year).Distinct().ToList();
        var monthNumbers = months.Select(m => m.Month).Distinct().ToList();

        var lines = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && years.Contains(i.BudgetCategory.BudgetMonth.Year)
                        && monthNumbers.Contains(i.BudgetCategory.BudgetMonth.Month))
            .Select(i => new
            {
                i.Id,
                i.BudgetCategory.BudgetMonth.Year,
                i.BudgetCategory.BudgetMonth.Month,
                Kind = i.BudgetCategory.Kind,
                CategoryName = i.BudgetCategory.Name,
                ItemName = i.Name,
                i.SavingsId,
            })
            .ToListAsync(cancellationToken);

        var lineIdByMonthIdentity = new Dictionary<(int Year, int Month, string Identity), Guid>();
        foreach (var l in lines)
        {
            if (!months.Contains((l.Year, l.Month)))
            {
                continue;
            }
            var identity = LineIdentity(l.Kind, l.CategoryName, l.ItemName, l.SavingsId);
            lineIdByMonthIdentity.TryAdd((l.Year, l.Month, identity), l.Id);
        }

        foreach (var r in requests)
        {
            var key = NormalizeDescription(r.Payee);
            if (identityByPayee.TryGetValue(key, out var identity)
                && lineIdByMonthIdentity.TryGetValue((r.Year, r.Month, identity), out var itemId))
            {
                result[(key, r.Year, r.Month)] = itemId;
            }
        }

        return result;
    }

    /// <summary>
    /// The stable cross-month identity of a budget line: a fund's <c>SavingsId</c> (which the
    /// rollover carries), else its category kind + category name + line name (also carried).
    /// </summary>
    private static string LineIdentity(CategoryKind kind, string? categoryName, string? itemName, Guid? savingsId)
        => savingsId is { } sid
            ? "s:" + sid.ToString("N")
            : $"k:{(int)kind}|c:{NormalizeDescription(categoryName)}|i:{NormalizeDescription(itemName)}";

    /// <summary>Public access to the normalization used for suggestion/dedup keys.</summary>
    public static string NormalizeKey(string? description) => NormalizeDescription(description);

    /// <summary>
    /// Normalize a description into a stable match key: trimmed, lower-cased, with internal
    /// whitespace collapsed. Returns "" for blank input.
    /// </summary>
    private static string NormalizeDescription(string? description)
    {
        if (string.IsNullOrWhiteSpace(description))
        {
            return string.Empty;
        }
        return WhitespacePattern().Replace(description.Trim().ToLowerInvariant(), " ");
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespacePattern();
}
