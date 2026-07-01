using Xunit;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Infrastructure;

public class UserPreferencesTests
{
    [Theory]
    [InlineData("EUR", "EUR")]
    [InlineData("gbp", "GBP")]
    [InlineData("  chf  ", "CHF")]
    public void NormalizeCurrency_ReturnsCanonicalCode(string input, string expected)
    {
        Assert.Equal(expected, UserPreferences.NormalizeCurrency(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeCurrency_BlankFallsBackToDefault(string? input)
    {
        Assert.Equal(UserPreferences.DefaultCurrency, UserPreferences.NormalizeCurrency(input));
    }

    [Theory]
    [InlineData("EU")]
    [InlineData("EURO")]
    [InlineData("E1R")]
    public void NormalizeCurrency_InvalidReturnsNull(string input)
    {
        Assert.Null(UserPreferences.NormalizeCurrency(input));
    }

    [Theory]
    [InlineData("dot-comma")]
    [InlineData("comma-dot")]
    [InlineData("space-comma")]
    public void NormalizeNumberFormat_AcceptsSupportedKeys(string input)
    {
        Assert.Equal(input, UserPreferences.NormalizeNumberFormat(input));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void NormalizeNumberFormat_BlankFallsBackToDefault(string? input)
    {
        Assert.Equal(UserPreferences.DefaultNumberFormat, UserPreferences.NormalizeNumberFormat(input));
    }

    [Theory]
    [InlineData("de-DE")]
    [InlineData("dot_comma")]
    [InlineData("nonsense")]
    public void NormalizeNumberFormat_UnsupportedReturnsNull(string input)
    {
        Assert.Null(UserPreferences.NormalizeNumberFormat(input));
    }
}
