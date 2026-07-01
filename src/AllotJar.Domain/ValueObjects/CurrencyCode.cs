using System.Text.RegularExpressions;

namespace AllotJar.Domain.ValueObjects;

/// <summary>
/// An ISO 4217 currency code (e.g. EUR, GBP, CHF). A value object: two codes are
/// equal when their three-letter value matches. Construction is validated so an
/// invalid code can never enter the domain.
/// </summary>
public sealed partial record CurrencyCode
{
    public string Value { get; }

    private CurrencyCode(string value) => Value = value;

    /// <summary>Parse and validate a 3-letter ISO 4217 code (case-insensitive).</summary>
    public static CurrencyCode From(string code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            throw new ArgumentException("Currency code is required.", nameof(code));
        }

        var normalized = code.Trim().ToUpperInvariant();
        if (!IsoCodePattern().IsMatch(normalized))
        {
            throw new ArgumentException(
                $"'{code}' is not a valid ISO 4217 currency code (expected three letters).",
                nameof(code));
        }

        return new CurrencyCode(normalized);
    }

    /// <summary>The application's default home currency.</summary>
    public static readonly CurrencyCode Eur = From("EUR");

    public override string ToString() => Value;

    [GeneratedRegex("^[A-Z]{3}$")]
    private static partial Regex IsoCodePattern();
}
