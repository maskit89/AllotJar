using MediatR;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions.Queries.GetConversionSuggestion;

public class GetConversionSuggestionQueryHandler : IRequestHandler<GetConversionSuggestionQuery, ConversionSuggestionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IExchangeRateProvider _rates;
    private readonly IIdentityService? _identity;

    public GetConversionSuggestionQueryHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IExchangeRateProvider rates, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _rates = rates;
        _identity = identity;
    }

    public async Task<ConversionSuggestionDto> Handle(GetConversionSuggestionQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        CurrencyCode currency;
        try
        {
            currency = CurrencyCode.From(request.Currency);
        }
        catch (ArgumentException)
        {
            throw Refuse("Currency", "Currency must be a 3-letter ISO 4217 code.");
        }
        if (request.Amount <= 0m)
        {
            throw Refuse("Amount", "Enter an amount greater than zero.");
        }
        // No day's rate exists yet for a future date (the source would answer with its latest one).
        if (request.Date > DateOnly.FromDateTime(DateTime.UtcNow))
        {
            throw Refuse("Date", "There is no reference rate for a future date yet. Enter the amount yourself.");
        }

        var budgetCurrency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken);
        if (currency == budgetCurrency)
        {
            throw Refuse("Currency", $"The budget is in {budgetCurrency.Value} already; there is nothing to convert.");
        }

        var suggestion = await ForeignAmounts.SuggestAsync(
            _rates, currency, budgetCurrency, request.Amount, request.Date, cancellationToken);
        return new ConversionSuggestionDto
        {
            Currency = currency.Value,
            Amount = request.Amount,
            BudgetCurrency = budgetCurrency.Value,
            Date = request.Date,
            Rate = suggestion?.Rate,
            SuggestedAmount = suggestion?.Amount,
        };
    }

    private static ValidationException Refuse(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
