using System.Collections.Concurrent;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Resolves currency rates from the free, key-less Frankfurter API (ECB daily
/// reference rates, with historical lookups by date). Results are cached per
/// (from, to, date) — those rates never change. Any failure returns null so the
/// caller falls back gracefully; FX must never break an import.
/// </summary>
public class FrankfurterExchangeRateProvider : IExchangeRateProvider
{
    // Rates for a past date are immutable, so a process-wide cache is safe.
    private static readonly ConcurrentDictionary<(string, string, DateOnly), decimal?> Cache = new();

    private readonly HttpClient _http;
    private readonly ILogger<FrankfurterExchangeRateProvider> _logger;

    public FrankfurterExchangeRateProvider(HttpClient http, ILogger<FrankfurterExchangeRateProvider> logger)
    {
        _http = http;
        _logger = logger;
    }

    public async Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
    {
        if (Equals(from, to))
        {
            return 1m;
        }

        var key = (from.Value, to.Value, date);
        if (Cache.TryGetValue(key, out var cached))
        {
            return cached;
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

        Cache[key] = rate;
        return rate;
    }

    private sealed record FrankfurterResponse(Dictionary<string, decimal>? Rates);
}
