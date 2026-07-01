namespace AllotJar.Domain.ValueObjects;

/// <summary>
/// An amount paired with its currency. Always <see cref="decimal"/> for exact
/// financial precision. Cross-currency arithmetic is forbidden — adding EUR to
/// GBP throws rather than silently producing a meaningless number. Convert via
/// an explicit exchange rate first (see <see cref="Entities.Transaction"/>).
/// </summary>
public readonly record struct Money(decimal Amount, CurrencyCode Currency)
{
    public static Money Zero(CurrencyCode currency) => new(0m, currency);

    public Money Add(Money other)
    {
        EnsureSameCurrency(other);
        return this with { Amount = Amount + other.Amount };
    }

    public Money Subtract(Money other)
    {
        EnsureSameCurrency(other);
        return this with { Amount = Amount - other.Amount };
    }

    public static Money operator +(Money a, Money b) => a.Add(b);
    public static Money operator -(Money a, Money b) => a.Subtract(b);

    public bool IsZero => Amount == 0m;
    public bool IsNegative => Amount < 0m;

    private void EnsureSameCurrency(Money other)
    {
        if (!Equals(Currency, other.Currency))
        {
            throw new InvalidOperationException(
                $"Cannot operate on Money of different currencies ({Currency} vs {other.Currency}).");
        }
    }

    public override string ToString() => $"{Amount:0.####} {Currency}";
}
