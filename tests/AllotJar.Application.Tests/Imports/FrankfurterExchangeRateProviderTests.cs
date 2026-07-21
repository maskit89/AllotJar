using System.Net;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

public class FrankfurterExchangeRateProviderTests
{
    // The provider's cache is static (process-wide), so every test uses its own unique
    // date to stay isolated from the rest of the run.

    private sealed class StubHandler : HttpMessageHandler
    {
        public int Requests { get; private set; }
        public Func<HttpResponseMessage> Respond { get; set; } =
            () => new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(Respond());
        }
    }

    private sealed class FakeClock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static HttpResponseMessage Ok(string eurRate) => new(HttpStatusCode.OK)
    {
        Content = new StringContent($"{{\"rates\":{{\"EUR\":{eurRate}}}}}", Encoding.UTF8, "application/json"),
    };

    private static FrankfurterExchangeRateProvider NewProvider(StubHandler handler, FakeClock clock) =>
        new(new HttpClient(handler) { BaseAddress = new Uri("https://fx.test/") },
            NullLogger<FrankfurterExchangeRateProvider>.Instance,
            clock);

    [Fact]
    public async Task FailedLookup_IsRetried_AfterTheFailureInterval()
    {
        var date = new DateOnly(1999, 1, 4);
        var handler = new StubHandler();
        var clock = new FakeClock();
        var provider = NewProvider(handler, clock);

        // Outage: the failure is cached, so an immediate retry doesn't re-hit the API…
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, date, CancellationToken.None)).Should().BeNull();
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, date, CancellationToken.None)).Should().BeNull();
        handler.Requests.Should().Be(1);

        // …but once the interval passes, the recovered API is consulted again. A permanently
        // cached failure would pin FxPending rows unresolved until an app restart.
        handler.Respond = () => Ok("1.15");
        clock.Now += FrankfurterExchangeRateProvider.FailureRetryInterval + TimeSpan.FromSeconds(1);
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, date, CancellationToken.None)).Should().Be(1.15m);
        handler.Requests.Should().Be(2);
    }

    [Fact]
    public async Task SuccessfulLookup_IsCachedForTheProcessLifetime()
    {
        var date = new DateOnly(1999, 2, 4);
        var handler = new StubHandler { Respond = () => Ok("1.20") };
        var clock = new FakeClock();
        var provider = NewProvider(handler, clock);

        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, date, CancellationToken.None)).Should().Be(1.20m);
        clock.Now += TimeSpan.FromDays(365);
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, date, CancellationToken.None)).Should().Be(1.20m);
        handler.Requests.Should().Be(1); // rates for a past date are immutable
    }
}
