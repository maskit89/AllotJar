using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.TestDoubles;

/// <summary>
/// Deterministic exchange-rate provider for tests — never touches the network.
/// Returns 1 for same-currency, otherwise the configured rate (null = unavailable).
/// </summary>
public sealed class FakeExchangeRateProvider : IExchangeRateProvider
{
    private readonly decimal? _rate;

    public FakeExchangeRateProvider(decimal? rate = null) => _rate = rate;

    public int Calls { get; private set; }

    public Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
    {
        // Counted BEFORE the same-currency shortcut so "no provider lookup" assertions
        // actually fail if a caller starts routing same-currency pairs through here.
        Calls++;
        if (Equals(from, to))
        {
            return Task.FromResult<decimal?>(1m);
        }
        return Task.FromResult(_rate);
    }
}
