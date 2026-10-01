using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The real 429: a dedicated API instance (own factory, own throwaway database, own in-process
/// rate limiter) configured with <c>RateLimiting:AuthPermitLimit = 3</c> — the same key the
/// journey harness raises to 1000 to avoid self-throttling, exercised here in the opposite
/// direction. Program.cs applies that limit as a fixed one-minute window per visitor, partitioned
/// by the visitor's address once X-Forwarded-For is unwound through the trusted proxies
/// (ClientAddress), on every endpoint tagged [EnableRateLimiting("auth")].
///
/// This class deliberately shares NOTHING with the sweep/matrix collection: tripping a limiter is
/// global state for its partition, so it gets its own factory (and xUnit runs separate collections
/// in isolation), leaving the sweep's raised-limit factory untouched.
/// </summary>
public sealed class RateLimit429Tests : IAsyncLifetime
{
    private const int PermitLimit = 3;

    private readonly ApiFactory _factory = new(
        databaseName: "AllotJar_HttpRateLimit",
        extraSettings: new Dictionary<string, string?>
        {
            ["RateLimiting:AuthPermitLimit"] = PermitLimit.ToString(),
        });

    public async Task InitializeAsync() => await _factory.ResetDatabaseAsync();

    public async Task DisposeAsync() => await _factory.DisposeAsync();

    [Fact]
    public async Task Login_returns_a_real_429_once_the_auth_window_is_exhausted()
    {
        using var client = _factory.CreateClient();

        // Bad credentials are fine: the limiter sits BEFORE authentication in the pipeline
        // (UseRateLimiter -> UseAuthentication), so every attempt consumes a permit.
        var body = new { email = "nobody@ratelimit.test", password = "definitely-wrong" };

        // The first <PermitLimit> attempts must pass the limiter and reach authentication,
        // which rejects the unknown user with a 401 — not a 429.
        for (var attempt = 1; attempt <= PermitLimit; attempt++)
        {
            using var response = await client.PostAsJsonAsync("/api/auth/login", body, HttpApiFixture.Json);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
                $"attempt {attempt}/{PermitLimit} is within the window and must reach credential checking");
        }

        // The very next attempt in the same fixed window must be rejected by the limiter itself.
        using var limited = await client.PostAsJsonAsync("/api/auth/login", body, HttpApiFixture.Json);
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests,
            "the fixed window is exhausted, so the rate limiter must reject with the configured 429");

        // Program.cs configures RejectionStatusCode but no OnRejected callback, so the middleware
        // sends the bare 429 without a Retry-After header — assert that stays true so a future
        // change that starts advertising retry timing is a conscious one.
        limited.Headers.Contains("Retry-After").Should().BeFalse(
            "no OnRejected handler sets Retry-After today; if one is added, update this assertion deliberately");

        // And the limit is per-window, not a lockout: an unrelated non-auth-tagged endpoint
        // (the anonymous features read) is unaffected by the tripped auth partition.
        using var untouched = await client.GetAsync("/api/features");
        untouched.StatusCode.Should().Be(HttpStatusCode.OK,
            "only endpoints tagged with the 'auth' policy are throttled");
    }

    // ---------------------------------------------------------------------------------------
    // S-P2-4: behind Cloudflare and IIS/ARR every request reaches Kestrel from loopback. The
    // limit must still be per visitor, never per site, and a client must not choose its bucket.
    // ---------------------------------------------------------------------------------------

    /// <summary>The test header that stands in for the TCP peer address (TestServer has none).</summary>
    private const string PeerHeader = "X-Test-Peer";

    /// <summary>A Cloudflare edge address (173.245.48.0/20), as ARR appends it, with its port.</summary>
    private const string CloudflareEdge = "173.245.48.10:443";

    /// <summary>Sets the connection's remote address from <see cref="PeerHeader"/> (loopback by default), ahead of Program's pipeline.</summary>
    private sealed class PeerAddressStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((context, nextMiddleware) =>
            {
                context.Connection.RemoteIpAddress = context.Request.Headers.TryGetValue(PeerHeader, out var peer)
                    ? IPAddress.Parse(peer.ToString())
                    : IPAddress.Loopback;
                return nextMiddleware(context);
            });
            next(app);
        };
    }

    private HttpClient BehindProxiesClient() =>
        _factory.WithWebHostBuilder(b => b.ConfigureServices(s => s.AddSingleton<IStartupFilter, PeerAddressStartupFilter>()))
            .CreateClient();

    private static async Task<HttpStatusCode> LoginAsync(HttpClient client, string forwardedFor, string? peer = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/login")
        {
            Content = JsonContent.Create(new { email = "nobody@ratelimit.test", password = "definitely-wrong" }, options: HttpApiFixture.Json),
        };
        request.Headers.Add("X-Forwarded-For", forwardedFor);
        if (peer is not null)
        {
            request.Headers.Add(PeerHeader, peer);
        }
        using var response = await client.SendAsync(request);
        return response.StatusCode;
    }

    [Fact]
    public async Task Behind_cloudflare_and_iis_one_visitor_exhausting_the_window_does_not_lock_out_another()
    {
        using var client = BehindProxiesClient();

        for (var attempt = 1; attempt <= PermitLimit; attempt++)
        {
            (await LoginAsync(client, $"203.0.113.5, {CloudflareEdge}")).Should().Be(HttpStatusCode.Unauthorized);
        }
        (await LoginAsync(client, $"203.0.113.5, {CloudflareEdge}")).Should().Be(HttpStatusCode.TooManyRequests,
            "the flooding visitor is limited");

        (await LoginAsync(client, $"198.51.100.7, {CloudflareEdge}")).Should().Be(HttpStatusCode.Unauthorized,
            "another visitor arriving through the same proxies has a window of its own");
    }

    [Fact]
    public async Task A_visitor_cannot_pick_a_fresh_bucket_by_writing_its_own_forwarded_for()
    {
        using var client = BehindProxiesClient();

        // Everything left of what Cloudflare appended was written by the client and is ignored.
        for (var attempt = 1; attempt <= PermitLimit; attempt++)
        {
            (await LoginAsync(client, $"10.0.0.{attempt}, 203.0.113.9, {CloudflareEdge}")).Should().Be(HttpStatusCode.Unauthorized);
        }
        (await LoginAsync(client, $"10.0.0.99, 203.0.113.9, {CloudflareEdge}")).Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task A_request_that_skips_cloudflare_is_limited_on_its_own_address()
    {
        using var client = BehindProxiesClient();

        // Straight to IIS: ARR appends the caller's own address, which is not a Cloudflare one,
        // so whatever the caller wrote before it is never believed.
        for (var attempt = 1; attempt <= PermitLimit; attempt++)
        {
            (await LoginAsync(client, $"192.0.2.{attempt}, 192.0.2.200:5555")).Should().Be(HttpStatusCode.Unauthorized);
        }
        (await LoginAsync(client, "192.0.2.77, 192.0.2.200:5555")).Should().Be(HttpStatusCode.TooManyRequests);

        // A forwarded-for from a peer that is not a trusted proxy is ignored altogether.
        for (var attempt = 1; attempt <= PermitLimit; attempt++)
        {
            (await LoginAsync(client, $"192.0.2.{attempt + 10}", peer: "192.0.2.201")).Should().Be(HttpStatusCode.Unauthorized);
        }
        (await LoginAsync(client, "192.0.2.50", peer: "192.0.2.201")).Should().Be(HttpStatusCode.TooManyRequests);
    }

    [Fact]
    public async Task Silent_refresh_has_its_own_bucket_so_a_sign_in_flood_does_not_end_open_sessions()
    {
        using var client = BehindProxiesClient();

        for (var attempt = 1; attempt <= PermitLimit + 1; attempt++)
        {
            await LoginAsync(client, $"203.0.113.44, {CloudflareEdge}");
        }
        (await LoginAsync(client, $"203.0.113.44, {CloudflareEdge}")).Should().Be(HttpStatusCode.TooManyRequests);

        using var refresh = new HttpRequestMessage(HttpMethod.Post, "/api/auth/refresh");
        refresh.Headers.Add("X-Forwarded-For", $"203.0.113.44, {CloudflareEdge}");
        using var response = await client.SendAsync(refresh);
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            "with no cookie the refresh is refused on its merits, not by the sign-in window");
    }
}
