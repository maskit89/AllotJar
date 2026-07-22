using System.Collections.Concurrent;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Resolves currency rates from the free, key-less Frankfurter API (ECB daily
/// reference rates, with historical lookups by date). Successful results are cached per
/// (from, to, date) for the process lifetime — those rates never change. Failures are
/// cached only for <see cref="FailureRetryInterval"/>: long enough that an outage doesn't
/// hammer the API, short enough that FxPending reconciliation (which re-attempts
/// unresolved rows on later imports) can actually succeed once the provider recovers —
/// a permanently-cached failure would pin rows pending until an app restart. Any failure
/// returns null so the caller falls back gracefully; FX must never break an import.
/// </summary>
public class FrankfurterExchangeRateProvider : IExchangeRateProvider
{
    /// <summary>How long a failed (null) lookup is cached before it may be retried.</summary>
    public static readonly TimeSpan FailureRetryInterval = TimeSpan.FromMinutes(10);

    // Rates for a past date are immutable, so caching successes process-wide is safe.
    // Failures carry their timestamp so they expire after FailureRetryInterval.
    private static readonly ConcurrentDictionary<(string, string, DateOnly), (decimal? Rate, DateTimeOffset At)> Cache = new();

    private readonly HttpClient _http;
    private readonly ILogger<FrankfurterExchangeRateProvider> _logger;
    private readonly TimeProvider _clock;

    public FrankfurterExchangeRateProvider(
        HttpClient http,
        ILogger<FrankfurterExchangeRateProvider> logger,
        TimeProvider clock)
    {
        _http = http;
        _logger = logger;
        _clock = clock;
    }

    public async Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
    {
        if (Equals(from, to))
        {
            return 1m;
        }

        var key = (from.Value, to.Value, date);
        if (Cache.TryGetValue(key, out var cached)
            && (cached.Rate is not null || _clock.GetUtcNow() - cached.At < FailureRetryInterval))
        {
            return cached.Rate;
        }

        decimal? rate = null;
        try
        {
            // e.g. https://api.frankfurter.app/2026-06-01?from=GBP&to=EUR
            var url = $"{date:yyyy-MM-dd}?from={from.Value}&to={to.Value}";
            var response = await _http.GetFromJsonAsync<FrankfurterResponse>(url, cancellationToken);

            if (response?.Rates is not null && response.Rates.TryGetValue(to.Value, out var value))
            {
                rate = value;
            }
        }
        catch (Exception ex)
        {
            // Network/parse failure — degrade gracefully.
            _logger.LogWarning(ex, "FX rate lookup failed for {From}->{To} on {Date}", from.Value, to.Value, date);
        }

        Cache[key] = (rate, _clock.GetUtcNow());
        return rate;
    }

    private sealed record FrankfurterResponse(Dictionary<string, decimal>? Rates);
}
