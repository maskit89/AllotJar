using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions;

/// <summary>
/// Money recorded in a currency other than the budget's (rules 42–44, 85). The app never
/// converts an amount by itself: a row in another currency waits (<see cref="Transaction.FxPending"/>)
/// and counts nowhere until the user enters its budget-currency amount, and a suggested
/// conversion is only ever a suggestion the user confirms.
/// </summary>
public static class ForeignAmounts
{
    /// <summary>Suggested amounts are rounded to cents, the precision every entry form uses.</summary>
    public const int SuggestionDecimals = 2;

    /// <summary>Where suggested rates come from, as the user is told.</summary>
    public const string SuggestionSource = "European Central Bank reference rate";

    /// <summary>
    /// Mark each new row in another currency as waiting for its budget-currency amount. A
    /// transfer moves one authoritative amount between two same-currency accounts and never
    /// enters a budget figure, so it never waits.
    /// </summary>
    public static void MarkWaiting(IEnumerable<Transaction> rows, CurrencyCode budgetCurrency)
    {
        foreach (var row in rows)
        {
            row.FxPending = row.Type != TransactionType.Transfer && row.Currency != budgetCurrency;
        }
    }

    /// <summary>
    /// A suggested budget-currency amount for <paramref name="amount"/> in <paramref name="currency"/>
    /// on <paramref name="date"/>: the reference rate for that day and the amount it gives,
    /// rounded to cents. Null when no rate is available; the user then types the amount.
    /// Nothing is recorded.
    /// </summary>
    public static async Task<(decimal Rate, decimal Amount)?> SuggestAsync(
        IExchangeRateProvider provider,
        CurrencyCode currency,
        CurrencyCode budgetCurrency,
        decimal amount,
        DateOnly date,
        CancellationToken cancellationToken)
    {
        var rate = await provider.GetRateAsync(currency, budgetCurrency, date, cancellationToken);
        if (rate is not decimal found || found <= 0m)
        {
            return null;
        }
        return (found, Math.Round(amount * found, SuggestionDecimals, MidpointRounding.AwayFromZero));
    }
}
