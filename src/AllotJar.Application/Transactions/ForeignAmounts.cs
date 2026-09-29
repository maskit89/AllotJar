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
    /// What a row counts in the budget: nothing while it waits for its budget-currency amount,
    /// else <see cref="Transaction.BudgetAmount"/> for a row whose amount is an account's other
    /// currency, else its amount.
    /// </summary>
    public static decimal? Counted(Transaction row) => row.FxPending ? null : row.BudgetAmount ?? row.Amount;

    /// <summary>
    /// Share a row's <see cref="Transaction.BudgetAmount"/> over its slices in proportion to their
    /// amounts, rounded to four decimals, the largest slice taking the rounding so the shares add
    /// up to the row's figure exactly (the same rule the <c>ForeignAmounts</c> migration used).
    /// This divides a figure the user or the migration fixed; it is not a rate. A row without a
    /// budget figure leaves its slices without one.
    /// </summary>
    public static void ShareOverSlices(Transaction row, IReadOnlyCollection<TransactionSplit>? slices = null)
    {
        slices ??= row.Splits.ToList();
        if (row.BudgetAmount is not decimal figure || row.Amount == 0m)
        {
            foreach (var slice in slices)
            {
                slice.BudgetAmount = null;
            }
            return;
        }
        if (slices.Count == 0)
        {
            return;
        }
        foreach (var slice in slices)
        {
            slice.BudgetAmount = Math.Round(slice.Amount * figure / row.Amount, 4, MidpointRounding.AwayFromZero);
        }
        var largest = slices.OrderByDescending(s => s.Amount).ThenBy(s => s.Id).First();
        largest.BudgetAmount += figure - slices.Sum(s => s.BudgetAmount!.Value);
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
