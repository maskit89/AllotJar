using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.ImportStatement;
using AllotJar.Application.Tests.Imports;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Transactions;

public class FxRateResolverTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-fx-{Guid.NewGuid()}")
            .Options);

    private static void SeedEurMonth(ApplicationDbContext db, string ownerId, int year, int month)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
        });
        db.SaveChanges();
    }

    private static Transaction ForeignTx(string currency, DateOnly date) => new()
    {
        OwnerId = "user-1",
        Amount = 40m,
        Currency = CurrencyCode.From(currency),
        ExchangeRate = 1m,
        Type = TransactionType.Expense,
        Date = date,
    };

    [Fact]
    public async Task Apply_ConvertsForeignToBaseAndSetsRate()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(1.15m), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(1);
        tx.ExchangeRate.Should().Be(1.15m);
        tx.BaseAmount.Should().Be(46.00m); // 40 GBP * 1.15
    }

    [Fact]
    public async Task Apply_SameCurrency_StaysRateOne_AndNotCounted()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = new Transaction { OwnerId = "user-1", Amount = 10m, Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 6, 3), Type = TransactionType.Expense };

        var provider = new FakeExchangeRateProvider(1.15m);
        var converted = await FxRateResolver.ApplyAsync(db, provider, "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(0);
        tx.ExchangeRate.Should().Be(1m);
        provider.Calls.Should().Be(0); // no lookup for same-currency
    }

    [Fact]
    public async Task Apply_WhenRateUnavailable_FallsBackToOne()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        // null = provider couldn't resolve a rate
        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(null), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(0);
        tx.ExchangeRate.Should().Be(1m); // import still completes
    }

    [Fact]
    public async Task Apply_DefaultsToEur_WhenNoBudgetForThatMonth()
    {
        await using var db = NewContext();
        // No budget month seeded -> base defaults to EUR; GBP is still foreign.
        var tx = ForeignTx("GBP", new DateOnly(2026, 6, 3));

        var converted = await FxRateResolver.ApplyAsync(
            db, new FakeExchangeRateProvider(1.2m), "user-1", new[] { tx }, CancellationToken.None);

        converted.Should().Be(1);
        tx.ExchangeRate.Should().Be(1.2m);
    }

    [Fact]
    public async Task Import_ResolvesRatesForForeignEntries()
    {
        await using var db = NewContext();
        SeedEurMonth(db, "user-1", 2026, 6);

        // The sample has one GBP entry (London Cab, 45.50, 2026-06-03) + two EUR.
        var handler = new ImportStatementCommandHandler(
            db, new CurrentUserStub("user-1"), new[] { new Camt053StatementParser() }, new FakeExchangeRateProvider(1.10m));

        await handler.Handle(new ImportStatementCommand(Camt053Samples.ThreeEntries), CancellationToken.None);

        var gbp = await db.Transactions.SingleAsync(t => t.Currency.Value == "GBP");
        gbp.ExchangeRate.Should().Be(1.10m);

        // EUR entries are untouched (rate 1).
        var eur = await db.Transactions.Where(t => t.Currency.Value == "EUR").ToListAsync();
        eur.Should().OnlyContain(t => t.ExchangeRate == 1m);
    }
}
