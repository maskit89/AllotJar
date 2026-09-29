using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Domain;

public class MoneyTests
{
    private static readonly CurrencyCode Eur = CurrencyCode.From("EUR");
    private static readonly CurrencyCode Gbp = CurrencyCode.From("GBP");

    [Fact]
    public void Add_SameCurrency_SumsAmounts()
    {
        var result = new Money(10.25m, Eur) + new Money(4.75m, Eur);

        Assert.Equal(15.00m, result.Amount);
        Assert.Equal(Eur, result.Currency);
    }

    [Fact]
    public void Subtract_SameCurrency_SubtractsAmounts()
    {
        var result = new Money(10m, Eur) - new Money(12m, Eur);

        Assert.Equal(-2m, result.Amount);
        Assert.True(result.IsNegative);
    }

    [Fact]
    public void Add_DifferentCurrencies_Throws()
    {
        var eur = new Money(10m, Eur);
        var gbp = new Money(10m, Gbp);

        var ex = Assert.Throws<InvalidOperationException>(() => eur + gbp);
        Assert.Contains("different currencies", ex.Message);
    }

    [Fact]
    public void PreservesDecimalPrecision()
    {
        var result = new Money(0.0001m, Eur) + new Money(0.0002m, Eur);

        Assert.Equal(0.0003m, result.Amount); // no float drift — it's decimal
    }

    [Fact]
    public void Zero_IsZeroInTheGivenCurrency()
    {
        var zero = Money.Zero(Gbp);

        Assert.True(zero.IsZero);
        Assert.Equal(Gbp, zero.Currency);
    }

    [Fact]
    public void RemainingToBudgetMoney_CarriesTheBudgetsBaseCurrency()
    {
        var month = new BudgetMonth
        {
            BaseCurrency = Gbp,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income",
                    Kind = CategoryKind.Income,
                    Items = new List<BudgetItem> { new() { PlannedAmount = 2000m } }
                },
                new() { Name = "Housing", Items = new List<BudgetItem> { new() { PlannedAmount = 1500m } } },
            },
        };

        var remaining = month.RemainingToBudgetMoney;

        Assert.Equal(500m, remaining.Amount);
        Assert.Equal(Gbp, remaining.Currency);
    }
}
