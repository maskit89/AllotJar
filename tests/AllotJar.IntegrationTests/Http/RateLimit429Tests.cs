using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The real 429: a dedicated API instance (own factory, own throwaway database, own in-process
/// rate limiter) configured with <c>RateLimiting:AuthPermitLimit = 3</c> — the same key the
/// journey harness raises to 1000 to avoid self-throttling, exercised here in the opposite
/// direction. Program.cs applies that limit as a fixed one-minute window per source, partitioned
/// by RemoteIpAddress, on every endpoint tagged [EnableRateLimiting("auth")].
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
}
