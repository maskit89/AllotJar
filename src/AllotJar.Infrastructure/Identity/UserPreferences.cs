using AllotJar.Domain.ValueObjects;

namespace AllotJar.Infrastructure.Identity;

/// <summary>
/// Validation/normalization for a user's display preferences (home currency + money
/// format). Shared by registration and the self-service preferences endpoint so both
/// accept exactly the same values, and co-located with <see cref="ApplicationUser"/>
/// because it defines the canonical values those columns may hold.
/// </summary>
public static class UserPreferences
{
    /// <summary>The application's home currency when the user hasn't chosen one.</summary>
    public const string DefaultCurrency = "EUR";

    /// <summary>
    /// The money format applied when the user hasn't chosen one. "comma-dot" (en-GB
    /// "1,234.56") is the app's neutral default — it matches the frontend fallback and
    /// the design's canonical rendering, and reads naturally the world over rather than
    /// assuming a European style. Registration always supplies an explicit choice, so
    /// this only backs the rare blank case.
    /// </summary>
    public const string DefaultNumberFormat = "comma-dot";

    /// <summary>
    /// The money grouping/decimal styles the UI can render. Keys are stable; the client
    /// maps each to a locale (comma-dot → en-GB "1,234.56", dot-comma → de-DE "1.234,56",
    /// space-comma → fr-FR "1 234,56", apostrophe → de-CH "1'234.56", lakh → en-IN
    /// "1,23,456.78"). Keep this in sync with client/src/lib/money.ts NUMBER_FORMAT_OPTIONS.
    /// </summary>
    public static readonly IReadOnlySet<string> NumberFormats =
        new HashSet<string>(StringComparer.Ordinal)
        {
            "comma-dot", "dot-comma", "space-comma", "apostrophe", "lakh",
        };

    /// <summary>
    /// Returns the canonical ISO 4217 code, or <c>null</c> if the supplied code is invalid.
    /// A blank value falls back to <see cref="DefaultCurrency"/>.
    /// </summary>
    public static string? NormalizeCurrency(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return DefaultCurrency;
        }

        try
        {
            return CurrencyCode.From(raw).Value;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    /// <summary>
    /// Returns the number-format key, or <c>null</c> if it isn't one we support.
    /// A blank value falls back to <see cref="DefaultNumberFormat"/>.
    /// </summary>
    public static string? NormalizeNumberFormat(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return DefaultNumberFormat;
        }

        var value = raw.Trim();
        return NumberFormats.Contains(value) ? value : null;
    }
}
