using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.ApiExplorer;
using Microsoft.Extensions.DependencyInjection;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The forgotten-[Authorize] guard: discovers EVERY controller endpoint from the running app's
/// ApiExplorer and calls each one anonymously over real HTTP. Everything must challenge with 401
/// except the explicitly curated allowlist below — so a brand-new endpoint that reaches main
/// without [Authorize] (or a controller added without the attribute) fails this sweep until it is
/// deliberately added to the list, in code review, as a conscious decision.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class AnonymousEndpointSweepTests
{
    private readonly HttpApiFixture _fixture;

    public AnonymousEndpointSweepTests(HttpApiFixture fixture) => _fixture = fixture;

    /// <summary>
    /// Every endpoint that is DELIBERATELY anonymous, as "METHOD path" (lowercase route template).
    /// Derived from the code, not from behaviour:
    ///   - auth register/login: no [Authorize] on AuthController, none on the actions — entry points.
    ///   - auth accept-invite / refresh / logout: explicitly [AllowAnonymous] (invite redemption,
    ///     cookie-only refresh, and sign-out that must work with an expired access token).
    ///   - features: explicitly anonymous feature-flag read the SPA needs before sign-in.
    /// (/health is anonymous too, but it is a health-check mapping, not a controller action, so
    /// ApiExplorer does not discover it; it is exercised separately below.)
    /// </summary>
    private static readonly IReadOnlySet<string> KnownAnonymous = new HashSet<string>(StringComparer.Ordinal)
    {
        "POST api/auth/register",
        "POST api/auth/login",
        "POST api/auth/accept-invite",
        "POST api/auth/refresh",
        "POST api/auth/logout",
        "GET api/features",
    };

    [Fact]
    public async Task Every_endpoint_requires_auth_except_the_curated_anonymous_allowlist()
    {
        var endpoints = DiscoverEndpoints();

        // Discovery sanity floor: 12 controllers currently expose 63 actions. If this collapses,
        // the sweep is not seeing the app and every assertion below would be vacuous.
        endpoints.Should().HaveCountGreaterThanOrEqualTo(60, "ApiExplorer should see the whole API surface");

        // The allowlist itself must stay honest: every entry must still exist.
        var discoveredKeys = endpoints.Select(e => e.Key).ToHashSet(StringComparer.Ordinal);
        KnownAnonymous.Should().BeSubsetOf(discoveredKeys,
            "stale allowlist entries must be removed when their endpoint goes away");

        using var client = _fixture.CreateClient();
        var violations = new List<string>();

        foreach (var endpoint in endpoints)
        {
            using var request = new HttpRequestMessage(new HttpMethod(endpoint.Method), endpoint.Url);
            if (endpoint.Method is "POST" or "PUT" or "PATCH")
            {
                // A harmless, well-formed-but-empty body in the endpoint's DECLARED content type.
                // Matching the declared type matters: for a multipart endpoint (the statement
                // uploads), a JSON probe is short-circuited to 415 by the framework's consumes
                // matcher BEFORE authorization runs, which would tell us nothing about [Authorize].
                request.Content = endpoint.IsMultipart
                    ? new MultipartFormDataContent()
                    : new StringContent("{}", Encoding.UTF8, "application/json");
            }

            using var response = await client.SendAsync(request);

            if (KnownAnonymous.Contains(endpoint.Key))
            {
                // Anonymity is this endpoint's deliberate, code-reviewed contract; just make sure
                // the harmless probe didn't blow it up.
                if ((int)response.StatusCode >= 500)
                {
                    violations.Add($"{endpoint.Key} is allowlisted anonymous but returned {(int)response.StatusCode}");
                }
            }
            else if (response.StatusCode != HttpStatusCode.Unauthorized)
            {
                violations.Add(
                    $"{endpoint.Key} returned {(int)response.StatusCode} anonymously — either add [Authorize] " +
                    "or, if it is deliberately public, add it to KnownAnonymous in this sweep");
            }
        }

        violations.Should().BeEmpty();
    }

    [Fact]
    public async Task Health_probe_is_anonymous_and_alive()
    {
        // The deploy pipeline's smoke test depends on /health being reachable without a token.
        using var client = _fixture.CreateClient();
        using var response = await client.GetAsync("/health");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    private sealed record SweepEndpoint(string Method, string Template, string Url, bool IsMultipart)
    {
        public string Key => $"{Method} {Template}";
    }

    /// <summary>
    /// Every action the app itself reports via ApiExplorer, with route parameters substituted with
    /// harmless constraint-satisfying values (so routing matches and the request reaches the auth
    /// layer instead of 404ing).
    /// </summary>
    private List<SweepEndpoint> DiscoverEndpoints()
    {
        var provider = _fixture.Services.GetRequiredService<IApiDescriptionGroupCollectionProvider>();

        return provider.ApiDescriptionGroups.Items
            .SelectMany(group => group.Items)
            .Where(d => d.HttpMethod is not null && d.RelativePath is not null)
            .Select(d => new SweepEndpoint(
                d.HttpMethod!.ToUpperInvariant(),
                d.RelativePath!.ToLowerInvariant(),
                "/" + SubstituteRouteParameters(d.RelativePath!),
                d.SupportedRequestFormats.Any(f =>
                    f.MediaType?.Contains("multipart/form-data", StringComparison.OrdinalIgnoreCase) == true)))
            .DistinctBy(e => e.Key)
            .OrderBy(e => e.Key, StringComparer.Ordinal)
            .ToList();
    }

    private static string SubstituteRouteParameters(string template) =>
        Regex.Replace(template, "\\{([^}]+)\\}", match =>
        {
            var name = match.Groups[1].Value.Split(':')[0].TrimEnd('?');
            return name.ToLowerInvariant() switch
            {
                "year" => "2026",
                "month" => "1",
                _ => Guid.NewGuid().ToString(), // {id}, {categoryId}, ... are all :guid-constrained
            };
        });
}
