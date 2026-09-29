using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Common.Interfaces;

/// <summary>
/// Looks up a reference rate for a given date, used only to SUGGEST a budget-currency amount the
/// user then confirms (rule 44). Implementations must degrade gracefully — returning null
/// (rather than throwing) when a rate can't be obtained.
/// </summary>
public interface IExchangeRateProvider
{
    /// <returns>Units of <paramref name="to"/> per one unit of <paramref name="from"/>, or null if unavailable.</returns>
    Task<decimal?> GetRateAsync(CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken);
}
