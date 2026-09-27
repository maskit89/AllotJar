using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions;

/// <summary>
/// Sets the exchange rate (to the budget's base currency) on transactions. Same-currency
/// entries get rate 1 with no lookup; foreign entries are resolved via
/// <see cref="IExchangeRateProvider"/>. When a rate can't be resolved the import still completes,
/// but the row is marked <see cref="Transaction.FxPending"/> (an explicit unresolved state, not a
/// silent 1:1) so a provider outage doesn't quietly distort base-currency totals.
/// <see cref="ReconcilePendingAsync"/> re-attempts previously-pending rows in its own save scope;
/// import handlers call it after their own save so an all-duplicates re-import still reconciles,
/// and a reconcile hiccup can never fail or roll back the import itself.
/// </summary>
public static class FxRateResolver
{
    /// <summary>Resolves rates for an incoming batch (typically unsaved import rows). Does not save.</summary>
    public static async Task<int> ApplyAsync(
        IApplicationDbContext db,
        IExchangeRateProvider provider,
        string ownerId,
        IReadOnlyList<Transaction> transactions,
        CancellationToken cancellationToken)
    {
        if (transactions.Count == 0)
        {
            return 0;
        }

        return await ResolveAsync(db, provider, ownerId, transactions, cancellationToken);
    }

    /// <summary>
    /// Re-attempts every previously-unresolved (<see cref="Transaction.FxPending"/>) row for the
    /// owner and persists the result in its own save scope. Kept separate from
    /// <see cref="ApplyAsync"/> so it runs even when an import created nothing new, and so
    /// touching old rows can never disturb the import's own save. A pending row deleted
    /// concurrently (second device, another household member) is skipped, not fatal.
    /// </summary>
    public static async Task<int> ReconcilePendingAsync(
        IApplicationDbContext db,
        IExchangeRateProvider provider,
        string ownerId,
        CancellationToken cancellationToken)
    {
        var pending = await db.Transactions
            .Where(t => t.OwnerId == ownerId && t.FxPending)
            .ToListAsync(cancellationToken);
        if (pending.Count == 0)
        {
            return 0;
        }

        var reconciled = await ResolveAsync(db, provider, ownerId, pending, cancellationToken);

        for (var attempt = 0; ; attempt++)
        {
            try
            {
                await db.SaveChangesAsync(cancellationToken);
                return reconciled;
            }
            catch (DbUpdateConcurrencyException ex) when (attempt < 3)
            {
                // A pending row was deleted while we were resolving — drop it from this
                // save and keep the rest; there is nothing left to reconcile for it.
                foreach (var entry in ex.Entries)
                {
                    entry.State = EntityState.Detached;
                }
            }
        }
    }

    /// <summary>
    /// Re-attempts pending rows for EVERY owner that has any — the entry point of the background
    /// reconciliation pass, so pending rows resolve on their own instead of waiting for that
    /// user's next import. Owners are processed independently: one owner's failure (or an
    /// unreachable provider) never blocks the others. Returns the number of rows resolved.
    /// </summary>
    public static async Task<int> ReconcileAllPendingAsync(
        IApplicationDbContext db,
        IExchangeRateProvider provider,
        CancellationToken cancellationToken)
    {
        var owners = await db.Transactions
            .Where(t => t.FxPending)
            .Select(t => t.OwnerId)
            .Distinct()
            .ToListAsync(cancellationToken);

        var reconciled = 0;
        foreach (var ownerId in owners)
        {
            cancellationToken.ThrowIfCancellationRequested();
            reconciled += await ReconcilePendingAsync(db, provider, ownerId, cancellationToken);
        }
        return reconciled;
    }

    private static async Task<int> ResolveAsync(
        IApplicationDbContext db,
        IExchangeRateProvider provider,
        string ownerId,
        IReadOnlyList<Transaction> transactions,
        CancellationToken cancellationToken)
    {
        // Base currency per month (default EUR when there's no budget for it yet).
        var months = await db.BudgetMonths
            .Where(m => m.OwnerId == ownerId)
            .Select(m => new { m.Year, m.Month, m.BaseCurrency })
            .ToListAsync(cancellationToken);
        var baseByMonth = months.ToDictionary(m => (m.Year, m.Month), m => m.BaseCurrency);

        var cache = new Dictionary<(string, string, DateOnly), decimal?>();
        var converted = 0;

        foreach (var tx in transactions)
        {
            // A transfer moves one authoritative amount between two same-currency accounts and
            // never enters a budget total, so it has no rate to resolve and must never be marked
            // pending: an unapproved rate on a transfer would be an automatic conversion (rule 42).
            if (tx.Type == TransactionType.Transfer)
            {
                tx.ExchangeRate = 1m;
                tx.FxPending = false;
                continue;
            }

            var baseCurrency = baseByMonth.TryGetValue((tx.Date.Year, tx.Date.Month), out var c)
                ? c
                : CurrencyCode.Eur;

            if (Equals(tx.Currency, baseCurrency))
            {
                tx.ExchangeRate = 1m;
                tx.FxPending = false;
                continue;
            }

            var key = (tx.Currency.Value, baseCurrency.Value, tx.Date);
            if (!cache.TryGetValue(key, out var rate))
            {
                rate = await provider.GetRateAsync(tx.Currency, baseCurrency, tx.Date, cancellationToken);
                cache[key] = rate;
            }

            if (rate is decimal resolved and > 0m)
            {
                tx.ExchangeRate = resolved;
                tx.FxPending = false;
                converted++;
            }
            else
            {
                // Couldn't resolve — record an explicit UNRESOLVED state instead of a silent 1:1.
                // The amount still counts at face value so the import completes, but FxPending marks
                // it so reads can flag it and the next reconcile pass retries it.
                tx.ExchangeRate = 1m;
                tx.FxPending = true;
            }
        }

        return converted;
    }
}
