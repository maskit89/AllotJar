using System.Collections.Concurrent;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Resolves currency rates from the free, key-less Frankfurter API (ECB daily
/// reference rates, with historical lookups by date). A published day's rate never changes,
/// so it is cached per (from, to, date) for the process lifetime. For a day the ECB has not
/// published yet (today before about 16:00 CET, a weekend, a holiday) Frankfurter answers
/// with the latest published day's rate and says which day that is: that answer is cached
/// under the day it is for, and under the day asked for only for
/// <see cref="FailureRetryInterval"/>, so today's suggestion picks up today's rate once it is
/// out instead of showing yesterday's until the API restarts. Failures are cached for the same
/// interval: long enough that an outage doesn't hammer the API, short enough that asking for a
/// suggestion again works once the provider recovers. The cache holds at most
/// <see cref="MaxCachedRates"/> entries; past that the oldest go. Any failure returns null: the
/// user is told no suggestion is available and types the amount. The rate only ever feeds a
/// suggestion the user confirms (rule 44).
/// </summary>
public class FrankfurterExchangeRateProvider : IExchangeRateProvider
{
    /// <summary>How long a failed (null) lookup, or a not-yet-published day's stand-in rate, is cached before it may be retried.</summary>
    public static readonly TimeSpan FailureRetryInterval = TimeSpan.FromMinutes(10);

    /// <summary>The most (from, to, date) entries the cache holds before the oldest are dropped.</summary>
    public const int MaxCachedRates = 10_000;

    /// <summary>
    /// A day this many days or more in the past that has no rate of its own never gets one (the
    /// ECB publishes on working days, by the evening), so its stand-in is cached for good.
    /// </summary>
    public const int StandInSettlesAfterDays = 2;

    // A published day's rate is immutable, so caching it process-wide is safe (Final). Failures
    // and stand-in rates carry their timestamp so they expire after FailureRetryInterval.
    private static readonly ConcurrentDictionary<(string, string, DateOnly), (decimal? Rate, DateTimeOffset At, bool Final)> Cache = new();

    /// <summary>Forgets every cached rate (tests).</summary>
    public static void ClearCache() => Cache.Clear();

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
        var now = _clock.GetUtcNow();
        if (Cache.TryGetValue(key, out var cached)
            && (cached.Final || now - cached.At < FailureRetryInterval))
        {
            return cached.Rate;
        }

        decimal? rate = null;
        DateOnly? publishedFor = null;
        try
        {
            // e.g. https://api.frankfurter.app/2026-06-01?from=GBP&to=EUR
            var url = $"{date:yyyy-MM-dd}?from={from.Value}&to={to.Value}";
            var response = await _http.GetFromJsonAsync<FrankfurterResponse>(url, cancellationToken);

            if (response?.Rates is not null && response.Rates.TryGetValue(to.Value, out var value))
            {
                rate = value;
                publishedFor = response.Date;
            }
        }
        catch (Exception ex)
        {
            // Network/parse failure — degrade gracefully.
            _logger.LogWarning(ex, "FX rate lookup failed for {From}->{To} on {Date}", from.Value, to.Value, date);
        }

        // The day the rate is for is final; the day asked for is, only when they are the same day
        // (an answer that names no day is taken as the day asked for, as before), or when it is
        // long enough past that the ECB will never publish it (a weekend or holiday): a stand-in
        // for such a day is what the day will always get (#287 review P3-3).
        var today = DateOnly.FromDateTime(now.UtcDateTime);
        var final = rate is not null && (publishedFor is null || publishedFor == date || date <= today.AddDays(-StandInSettlesAfterDays));
        if (rate is not null && publishedFor is DateOnly published && published != date)
        {
            Cache[(from.Value, to.Value, published)] = (rate, now, true);
        }
        Cache[key] = (rate, now, final);
        Trim(now);
        return rate;
    }

    /// <summary>Keeps the cache within <see cref="MaxCachedRates"/>: expired entries go first, then the oldest.</summary>
    private static void Trim(DateTimeOffset now)
    {
        if (Cache.Count <= MaxCachedRates)
        {
            return;
        }
        foreach (var stale in Cache.Where(e => !e.Value.Final && now - e.Value.At >= FailureRetryInterval).Select(e => e.Key).ToList())
        {
            Cache.TryRemove(stale, out _);
        }
        if (Cache.Count <= MaxCachedRates)
        {
            return;
        }
        foreach (var oldest in Cache.OrderBy(e => e.Value.At).Take(Cache.Count - MaxCachedRates / 2).Select(e => e.Key).ToList())
        {
            Cache.TryRemove(oldest, out _);
        }
    }

    private sealed record FrankfurterResponse(Dictionary<string, decimal>? Rates, DateOnly? Date);
}
