using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Domain;

public class CurrencyCodeTests
{
    [Theory]
    [InlineData("EUR", "EUR")]
    [InlineData("gbp", "GBP")]
    [InlineData("  chf  ", "CHF")]
    public void From_NormalizesToUpperCaseTrimmed(string input, string expected)
    {
        Assert.Equal(expected, CurrencyCode.From(input).Value);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("EU")]
    [InlineData("EURO")]
    [InlineData("E1R")]
    [InlineData("12")]
    public void From_RejectsInvalidCodes(string input)
    {
        Assert.Throws<ArgumentException>(() => CurrencyCode.From(input));
    }

    [Fact]
    public void Equality_IsByValue()
    {
        Assert.Equal(CurrencyCode.From("EUR"), CurrencyCode.From("eur"));
        Assert.NotEqual(CurrencyCode.From("EUR"), CurrencyCode.From("USD"));
    }

    [Fact]
    public void Eur_IsTheDefault()
    {
        Assert.Equal("EUR", CurrencyCode.Eur.Value);
    }
}
