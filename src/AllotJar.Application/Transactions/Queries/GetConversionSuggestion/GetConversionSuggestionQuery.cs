using MediatR;

namespace AllotJar.Application.Transactions.Queries.GetConversionSuggestion;

/// <summary>
/// Suggests the budget-currency amount for <paramref name="Amount"/> paid in
/// <paramref name="Currency"/> on <paramref name="Date"/> (rule 44). Read-only: the suggestion is
/// applied only when the user confirms an amount (ConfirmConvertedAmount, or a new transaction's
/// amount), and it has no monetary effect before that.
/// </summary>
public record GetConversionSuggestionQuery(string Currency, decimal Amount, DateOnly Date) : IRequest<ConversionSuggestionDto>;

/// <summary>
/// A suggested conversion. <see cref="Rate"/> and <see cref="SuggestedAmount"/> are null when no
/// reference rate is available; the user then types the amount.
/// </summary>
public class ConversionSuggestionDto
{
    public string Currency { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string BudgetCurrency { get; set; } = string.Empty;
    public DateOnly Date { get; set; }
    public decimal? Rate { get; set; }
    public decimal? SuggestedAmount { get; set; }
    public string Source { get; set; } = ForeignAmounts.SuggestionSource;
}
