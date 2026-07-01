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

    /// <summary>The money format applied when the user hasn't chosen one (matches the historical de-DE rendering).</summary>
    public const string DefaultNumberFormat = "dot-comma";

    /// <summary>
    /// The money grouping/decimal styles the UI can render. Keys are stable; the client
    /// maps each to a locale (dot-comma → de-DE "1.234,56", comma-dot → en-GB "1,234.56",
    /// space-comma → fr-FR "1 234,56").
    /// </summary>
    public static readonly IReadOnlySet<string> NumberFormats =
        new HashSet<string>(StringComparer.Ordinal) { "dot-comma", "comma-dot", "space-comma" };

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
