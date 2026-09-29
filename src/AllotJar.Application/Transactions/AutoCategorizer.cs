using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// A lightweight, behind-the-scenes categorizer. When a transaction is logged without a budget
/// line, it inherits the line the user last used for the same description (payee) — but only
/// from PRIOR history in the SAME DIRECTION, resolved to the line IN THE TRANSACTION'S OWN
/// MONTH:
///
///   * Direction-aware: an income (e.g. a merchant refund) never inherits the expense line the
///     purchases used, and vice versa — the learned key includes the transaction's type, and a
///     resolved line is only applied when its kind matches the direction (the same
///     <see cref="TransactionInvariants.LineKindMatches"/> rule every write path enforces), so
///     legacy mis-categorized history can't propagate either.
///   * Truly prior: a candidate only learns from transactions dated on or before its own date —
///     a backdated entry can't inherit from the future. Candidates with different dates resolve
///     independently.
///   * Month-scoped: budget lines are month-scoped rows, so the learned line's stable
///     cross-month identity is looked up in the candidate's month; if that month has no
///     matching line, the payee is left unassigned. Transfers are never candidates.
///
/// Zero-configuration — there are no user-managed rules. Used by manual create and the import
/// preview. An entry in a private account is never assigned (W13): only
/// its holder puts it on the household budget.
/// </summary>
public static partial class AutoCategorizer
{
    public static async Task<int> ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Transaction> transactions,
        CancellationToken cancellationToken)
    {
        // Only unassigned income/expense transactions with a usable description are candidates —
        // a transfer never carries a line, so it never inherits one.
        var candidates = transactions
            .Where(t => t.BudgetItemId is null
                        && t.Type != TransactionType.Transfer
                        && NormalizeDescription(t.Payee).Length > 0)
            .ToList();
        if (candidates.Count == 0)
        {
            return 0;
        }

        // W13 (rule 31, P56): a private account's entry joins the household budget, and so becomes
        // visible to everyone, only when its holder puts it on a line. Never guess one for them.
        var accountIds = candidates.Where(t => t.AccountId is not null).Select(t => t.AccountId!.Value).Distinct().ToList();
        if (accountIds.Count > 0)
        {
            var privateIds = (await db.AccountPrivacies
                    .Where(p => accountIds.Contains(p.AccountId))
                    .Select(p => p.AccountId)
                    .ToListAsync(cancellationToken))
                .ToHashSet();
            candidates = candidates.Where(t => t.AccountId is not Guid a || !privateIds.Contains(a)).ToList();
            if (candidates.Count == 0)
            {
                return 0;
            }
        }

        // Never let a candidate match against itself (the batch may already be tracked).
        var candidateIds = candidates.Select(t => t.Id).ToHashSet();
        var requests = candidates
            .Select(t => (t.Payee, t.Type, t.Date))
            .ToList();

        var resolved = await ResolveLinesAsync(db, ownerId, candidateIds, requests, cancellationToken);
        if (resolved.Count == 0)
        {
            return 0;
        }

        var assigned = 0;
        foreach (var tx in candidates)
        {
            if (resolved.TryGetValue((NormalizeDescription(tx.Payee), tx.Type, tx.Date), out var itemId))
            {
                tx.BudgetItemId = itemId;
                assigned++;
            }
        }

        return assigned;
    }

    /// <summary>
    /// For each requested (payee, type, date), resolve the budget line to suggest/assign: the
    /// recurring line of the most recent SAME-DIRECTION transaction with that payee dated on or
    /// before the request, looked up IN THE REQUEST'S OWN MONTH. A line's cross-month identity
    /// is its fund <c>SavingsId</c>, else (category kind, category name, line name) — all of
    /// which the monthly rollover copies forward. If nothing qualifies, the payee is left
    /// unresolved. Shared by <see cref="ApplyAsync"/> and the import preview so the suggestion
    /// always matches what a commit would actually do.
    /// </summary>
    public static async Task<IReadOnlyDictionary<(string PayeeKey, TransactionType Type, DateOnly Date), Guid>> ResolveLinesAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlySet<Guid> excludeTransactionIds,
        IReadOnlyCollection<(string Payee, TransactionType Type, DateOnly Date)> requests,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<(string, TransactionType, DateOnly), Guid>();
        if (requests.Count == 0)
        {
            return result;
        }

        var payeeKeys = requests
            .Select(r => NormalizeDescription(r.Payee))
            .Where(k => k.Length > 0)
            .ToHashSet();
        if (payeeKeys.Count == 0)
        {
            return result;
        }

        // Every categorized prior transaction up to the newest request, newest first. Only rows
        // whose line's kind matches their own direction are teachers — a legacy
        // income-on-expense-line row must not propagate its mistake to new transactions.
        var latestRequestDate = requests.Max(r => r.Date);
        var prior = (await db.Transactions
                .AsNoTracking()
                .Where(t => t.OwnerId == ownerId
                            && t.BudgetItemId != null
                            && t.Type != TransactionType.Transfer
                            && t.Date <= latestRequestDate
                            && !excludeTransactionIds.Contains(t.Id))
                .OrderByDescending(t => t.Date)
                .ThenByDescending(t => t.Id)
                .Select(t => new
                {
                    t.Payee,
                    t.Type,
                    t.Date,
                    Kind = t.BudgetItem!.BudgetCategory.Kind,
                    CategoryName = t.BudgetItem.BudgetCategory.Name,
                    ItemName = t.BudgetItem.Name,
                    t.BudgetItem.SavingsId,
                })
                .ToListAsync(cancellationToken))
            .Where(p => TransactionInvariants.LineKindMatches(p.Kind, p.Type))
            .Select(p => new
            {
                Key = NormalizeDescription(p.Payee),
                p.Type,
                p.Date,
                Identity = LineIdentity(p.Kind, p.CategoryName, p.ItemName, p.SavingsId),
            })
            .Where(p => p.Key.Length > 0 && payeeKeys.Contains(p.Key))
            .ToList();
        if (prior.Count == 0)
        {
            return result;
        }

        // Per request: the most recent prior of the SAME payee and direction dated on or before
        // the request. `prior` is newest-first, so the first match wins.
        var identityByRequest = new Dictionary<(string, TransactionType, DateOnly), string>();
        foreach (var r in requests)
        {
            var key = NormalizeDescription(r.Payee);
            var reqKey = (key, r.Type, r.Date);
            if (key.Length == 0 || identityByRequest.ContainsKey(reqKey))
            {
                continue;
            }
            var teacher = prior.FirstOrDefault(p => p.Key == key && p.Type == r.Type && p.Date <= r.Date);
            if (teacher is not null)
            {
                identityByRequest[reqKey] = teacher.Identity;
            }
        }
        if (identityByRequest.Count == 0)
        {
            return result;
        }

        // Index the lines of every requested month by their identity. (EF can't filter on a set of
        // (year, month) tuples, so query the years×months superset and drop the cross-terms.)
        var months = requests.Select(r => (r.Date.Year, r.Date.Month)).Distinct().ToHashSet();
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

        var linesByMonthIdentity = new Dictionary<(int Year, int Month, string Identity), (Guid Id, CategoryKind Kind)>();
        foreach (var l in lines)
        {
            if (!months.Contains((l.Year, l.Month)))
            {
                continue;
            }
            var identity = LineIdentity(l.Kind, l.CategoryName, l.ItemName, l.SavingsId);
            linesByMonthIdentity.TryAdd((l.Year, l.Month, identity), (l.Id, l.Kind));
        }

        foreach (var pair in identityByRequest)
        {
            var (_, type, date) = pair.Key;
            if (linesByMonthIdentity.TryGetValue((date.Year, date.Month, pair.Value), out var line)
                // Belt and braces: the resolved line must satisfy the same direction↔kind rule
                // the write paths enforce, or the suggestion is dropped.
                && TransactionInvariants.LineKindMatches(line.Kind, type))
            {
                result[pair.Key] = line.Id;
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
