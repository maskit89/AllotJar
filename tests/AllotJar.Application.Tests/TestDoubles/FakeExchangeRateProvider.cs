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
        if (Equals(from, to))
        {
            return Task.FromResult<decimal?>(1m);
        }
        Calls++;
        return Task.FromResult(_rate);
    }
}
