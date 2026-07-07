using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// A lightweight, behind-the-scenes categorizer. When a transaction is logged
/// without a budget line, it inherits the line of the user's most recent earlier
/// transaction with the same description (payee). This is a zero-configuration
/// default — there are no user-managed rules — and applies both to manually-added
/// transactions and to any future statement import. Returns how many of the given
/// candidates were assigned.
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

        // Never let a candidate match against itself (the import batch isn't saved
        // yet, but be defensive).
        var candidateIds = candidates.Select(t => t.Id).ToHashSet();

        var lineByDescription = await BuildSuggestionsAsync(db, ownerId, candidateIds, cancellationToken);
        if (lineByDescription.Count == 0)
        {
            return 0;
        }

        var assigned = 0;
        foreach (var tx in candidates)
        {
            if (lineByDescription.TryGetValue(NormalizeDescription(tx.Payee), out var itemId))
            {
                tx.BudgetItemId = itemId;
                assigned++;
            }
        }

        return assigned;
    }

    /// <summary>
    /// Build the payee → budget-line suggestion index from the user's already-categorized
    /// transactions (most recent assignment wins). Used both by <see cref="ApplyAsync"/> and by
    /// the statement-import preview to suggest a line for each candidate before anything is saved.
    /// The key is the normalized payee (see <see cref="NormalizeKey"/>).
    /// </summary>
    public static async Task<Dictionary<string, Guid>> BuildSuggestionsAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlySet<Guid> excludeTransactionIds,
        CancellationToken cancellationToken)
    {
        // Most recent first, so the first write per description wins.
        var prior = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == ownerId
                        && t.BudgetItemId != null
                        && !excludeTransactionIds.Contains(t.Id))
            .OrderByDescending(t => t.Date)
            .ThenByDescending(t => t.Id)
            .Select(t => new { t.Payee, t.BudgetItemId })
            .ToListAsync(cancellationToken);

        var lineByDescription = new Dictionary<string, Guid>();
        foreach (var p in prior)
        {
            var key = NormalizeDescription(p.Payee);
            if (key.Length > 0 && !lineByDescription.ContainsKey(key))
            {
                lineByDescription[key] = p.BudgetItemId!.Value;
            }
        }
        return lineByDescription;
    }

    /// <summary>Public access to the normalization used for suggestion keys.</summary>
    public static string NormalizeKey(string? description) => NormalizeDescription(description);

    /// <summary>
    /// Normalize a description into a stable match key: trimmed, lower-cased, with
    /// internal whitespace collapsed. Returns "" for blank input.
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
