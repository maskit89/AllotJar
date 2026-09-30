using System.Net;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
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
        // cached failure would leave every suggestion unavailable until an app restart.
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

    private static HttpResponseMessage OkFor(string eurRate, DateOnly publishedFor) => new(HttpStatusCode.OK)
    {
        Content = new StringContent($"{{\"date\":\"{publishedFor:yyyy-MM-dd}\",\"rates\":{{\"EUR\":{eurRate}}}}}", Encoding.UTF8, "application/json"),
    };

    // #278 P3-2: for a day the ECB has not published yet, Frankfurter answers with the latest
    // published day's rate and names that day. It is cached under that day for good, and under
    // the day asked for only briefly, so today's rate is picked up once it is out.
    [Fact]
    public async Task ANotYetPublishedDay_TakesTheLatestRate_ButIsAskedAgain_OnceTheIntervalPasses()
    {
        var clock = new FakeClock();
        // Today by the clock: a day whose rate may still come (a day long past keeps its stand-in for good).
        var asked = DateOnly.FromDateTime(clock.Now.UtcDateTime);
        var published = asked.AddDays(-1);
        var handler = new StubHandler { Respond = () => OkFor("1.30", published) };
        var provider = NewProvider(handler, clock);

        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, asked, CancellationToken.None)).Should().Be(1.30m);
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, asked, CancellationToken.None)).Should().Be(1.30m);
        handler.Requests.Should().Be(1, "the stand-in rate is cached for the interval");
        // The day the rate is actually for is known for good without another call.
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, published, CancellationToken.None)).Should().Be(1.30m);
        handler.Requests.Should().Be(1);

        handler.Respond = () => OkFor("1.35", asked);
        clock.Now += FrankfurterExchangeRateProvider.FailureRetryInterval + TimeSpan.FromSeconds(1);
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, asked, CancellationToken.None)).Should().Be(1.35m, "the day's own rate is out now");
        handler.Requests.Should().Be(2);
        clock.Now += TimeSpan.FromDays(30);
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, asked, CancellationToken.None)).Should().Be(1.35m);
        handler.Requests.Should().Be(2, "a published day's rate is final");
    }

    // #287 review P3-3: a Saturday years ago never gets a rate of its own, so its stand-in
    // (the Friday's) is final rather than asked for again every interval.
    [Fact]
    public async Task APastWeekendDay_KeepsItsStandIn_ForGood()
    {
        var saturday = new DateOnly(1998, 5, 9);
        var friday = new DateOnly(1998, 5, 8);
        var handler = new StubHandler { Respond = () => OkFor("1.40", friday) };
        var clock = new FakeClock { Now = new DateTimeOffset(2027, 1, 13, 12, 0, 0, TimeSpan.Zero) }; // its own days, the cache being process-wide
        var provider = NewProvider(handler, clock);

        for (var i = 0; i < 6; i++)
        {
            (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, saturday, CancellationToken.None)).Should().Be(1.40m);
            clock.Now += FrankfurterExchangeRateProvider.FailureRetryInterval + TimeSpan.FromSeconds(1);
        }
        handler.Requests.Should().Be(1);

        // Yesterday's stand-in is still asked again: the day's own rate may be out by now.
        var yesterday = DateOnly.FromDateTime(clock.Now.UtcDateTime).AddDays(-1);
        handler.Respond = () => OkFor("1.41", yesterday.AddDays(-1));
        (await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, yesterday, CancellationToken.None)).Should().Be(1.41m);
        clock.Now += FrankfurterExchangeRateProvider.FailureRetryInterval + TimeSpan.FromSeconds(1);
        await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, yesterday, CancellationToken.None);
        handler.Requests.Should().Be(3);
    }

    [Fact]
    public async Task TheCache_IsBounded()
    {
        var handler = new StubHandler { Respond = () => Ok("1.10") };
        var clock = new FakeClock();
        var provider = NewProvider(handler, clock);
        FrankfurterExchangeRateProvider.ClearCache();
        var start = new DateOnly(1980, 1, 1);
        for (var i = 0; i <= FrankfurterExchangeRateProvider.MaxCachedRates; i++)
        {
            clock.Now += TimeSpan.FromSeconds(1);
            await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, start.AddDays(i), CancellationToken.None);
        }
        var before = handler.Requests;
        // The first day asked was the oldest entry, so it went; the last one is still there.
        await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, start, CancellationToken.None);
        handler.Requests.Should().Be(before + 1);
        await provider.GetRateAsync(CurrencyCode.From("GBP"), CurrencyCode.Eur, start.AddDays(FrankfurterExchangeRateProvider.MaxCachedRates), CancellationToken.None);
        handler.Requests.Should().Be(before + 1);
    }
}
