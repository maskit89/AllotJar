using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Api.Middleware;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// While SQL Server keeps the startup migrations waiting, the API runs with its gate closed and
/// every request (health checks included, so the deploy's liveness poll fails) answers 503 with
/// Retry-After, instead of the API failing to start (25 Oct 2026: after a VPS reboot an in-process
/// IIS app that failed to start stayed down until its app pool was restarted by hand).
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class DatabaseStartupGateHttpTests
{
    private readonly HttpApiFixture _fixture;

    public DatabaseStartupGateHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task A_closed_gate_answers_503_everywhere_and_an_open_one_serves_again()
    {
        var gate = _fixture.Services.GetRequiredService<DatabaseStartupGate>();
        using var client = _fixture.CreateClient();
        gate.Close();
        try
        {
            foreach (var path in new[] { "/health", "/health/ready", "/api/auth/me" })
            {
                var response = await client.GetAsync(path);

                response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, path);
                response.Headers.RetryAfter!.Delta.Should().Be(TimeSpan.FromSeconds(DatabaseStartupGateMiddleware.RetryAfterSeconds), path);
                var body = await response.Content.ReadFromJsonAsync<Dictionary<string, object>>();
                body!["code"].ToString().Should().Be(DatabaseStartupGateMiddleware.Code, path);
            }
        }
        finally
        {
            gate.Open();
        }

        (await client.GetAsync("/health")).StatusCode.Should().Be(HttpStatusCode.OK);
        (await client.GetAsync("/health/ready")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    // Boots its own API against a server nothing listens on: the ten startup attempts fail (about
    // 30 seconds), and the API must still start and answer 503 instead of throwing.
    [Fact]
    public async Task An_api_whose_database_never_answers_starts_and_answers_503()
    {
        await using var factory = new ApiFactory(
            databaseName: "AllotJar_NoServer",
            extraSettings: new Dictionary<string, string?>
            {
                ["ConnectionStrings:DefaultConnection"] =
                    "Server=127.0.0.1,1;Database=AllotJar_NoServer;User Id=sa;Password=x;Connect Timeout=1;TrustServerCertificate=True;Encrypt=False",
            });
        using var client = factory.CreateClient();

        factory.Services.GetRequiredService<DatabaseStartupGate>().IsOpen.Should().BeFalse();
        (await client.GetAsync("/health")).StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await client.GetAsync("/health/ready")).StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
    }
}
