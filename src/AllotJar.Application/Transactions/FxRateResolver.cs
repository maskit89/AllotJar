using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions;

/// <summary>
/// Sets the exchange rate (to the budget's base currency) on a batch of transactions. Same-
/// currency entries get rate 1 with no lookup; foreign entries are resolved via
/// <see cref="IExchangeRateProvider"/>. When a rate can't be resolved the import still completes,
/// but the row is marked <see cref="Transaction.FxPending"/> (an explicit unresolved state, not a
/// silent 1:1) so a provider outage doesn't quietly distort base-currency totals — and each pass
/// also re-attempts any previously-pending rows, so they reconcile on the next import.
/// </summary>
public static class FxRateResolver
{
    public static async Task<int> ApplyAsync(
        IApplicationDbContext db,
        IExchangeRateProvider provider,
        string ownerId,
        IReadOnlyList<Transaction> transactions,
        CancellationToken cancellationToken)
    {
        // Re-attempt any previously-unresolved foreign rows for this owner alongside the incoming
        // batch — an import is a natural moment to reconcile amounts whose rate was unavailable
        // before. (The incoming batch may be unsaved, so dedup by reference against it.)
        var pending = await db.Transactions
            .Where(t => t.OwnerId == ownerId && t.FxPending)
            .ToListAsync(cancellationToken);
        var batch = pending.Count == 0
            ? transactions
            : transactions.Concat(pending.Where(p => !transactions.Contains(p))).ToList();

        if (batch.Count == 0)
        {
            return 0;
        }

        // Base currency per month (default EUR when there's no budget for it yet).
        var months = await db.BudgetMonths
            .Where(m => m.OwnerId == ownerId)
            .Select(m => new { m.Year, m.Month, m.BaseCurrency })
            .ToListAsync(cancellationToken);
        var baseByMonth = months.ToDictionary(m => (m.Year, m.Month), m => m.BaseCurrency);

        var cache = new Dictionary<(string, string, DateOnly), decimal?>();
        var converted = 0;

        foreach (var tx in batch)
        {
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
                // it so reads can flag it and the next resolution pass retries it.
                tx.ExchangeRate = 1m;
                tx.FxPending = true;
            }
        }

        return converted;
    }
}
