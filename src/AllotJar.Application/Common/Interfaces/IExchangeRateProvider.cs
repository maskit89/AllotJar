using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Resolves a currency conversion rate for a given date. Implementations must
/// degrade gracefully — returning null (rather than throwing) when a rate can't
/// be obtained — so an import never fails because of FX.
/// </summary>
public interface IExchangeRateProvider
{
    /// <returns>Units of <paramref name="to"/> per one unit of <paramref name="from"/>, or null if unavailable.</returns>
    Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken);
}
