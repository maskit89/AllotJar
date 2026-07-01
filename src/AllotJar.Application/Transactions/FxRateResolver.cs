using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions;

/// <summary>
/// Sets the exchange rate (to the budget's base currency) on a batch of
/// transactions. Same-currency entries get rate 1 with no lookup; foreign
/// entries are resolved via <see cref="IExchangeRateProvider"/>, falling back to
/// 1 when no rate is available so an import always completes.
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
        if (transactions.Count == 0)
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

        foreach (var tx in transactions)
        {
            var baseCurrency = baseByMonth.TryGetValue((tx.Date.Year, tx.Date.Month), out var c)
                ? c
                : CurrencyCode.Eur;

            if (Equals(tx.Currency, baseCurrency))
            {
                tx.ExchangeRate = 1m;
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
                converted++;
            }
            else
            {
                // Couldn't resolve — keep 1 so the amount still counts (in its own currency).
                tx.ExchangeRate = 1m;
            }
        }

        return converted;
    }
}
