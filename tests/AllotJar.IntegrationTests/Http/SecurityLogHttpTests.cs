using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using AllotJar.Infrastructure.Logging;

namespace AllotJar.IntegrationTests.Http;

/// <summary>
/// The security log over real HTTP (audit A09-001): failed sign-ins and the lockout leave a Warning
/// that names the login's id, never its email, and a password change is recorded too.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class SecurityLogHttpTests
{
    private readonly HttpApiFixture _fixture;

    public SecurityLogHttpTests(HttpApiFixture fixture) => _fixture = fixture;

    private sealed class CapturedLogs : ILoggerProvider
    {
        public ConcurrentQueue<(string Category, LogLevel Level, string Message)> Lines { get; } = new();

        public ILogger CreateLogger(string categoryName) => new Logger(this, categoryName);

        public void Dispose() { }

        private sealed class Logger(CapturedLogs owner, string category) : ILogger
        {
            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
                owner.Lines.Enqueue((category, logLevel, formatter(state, exception)));
        }

        public string[] Security() =>
            Lines.Where(l => l.Category == SecurityEvents.Category && l.Level == LogLevel.Warning).Select(l => l.Message).ToArray();
    }

    [Fact]
    public async Task Wrong_passwords_and_the_lockout_are_logged_by_login_id_without_the_email()
    {
        var logs = new CapturedLogs();
        using var client = _fixture.CreateClient(b => b.ConfigureLogging(l => l.AddProvider(logs)));
        var email = $"log-{Guid.NewGuid():N}"[..14] + "@securitylog.test";
        var password = HttpApiFixture.StrongPassword();
        var register = await client.PostAsJsonAsync("/api/auth/register", new
        {
            email, password, firstName = "Lou", lastName = "Gs", preferredCurrency = "EUR", numberFormat = (string?)null, acceptedTerms = true,
        }, HttpApiFixture.Json);
        register.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = (await HttpApiFixture.ReadJsonAsync(register)).RootElement;
        var userId = body.GetProperty("userId").GetString()!;
        var token = body.GetProperty("token").GetString()!;

        (await client.PostAsJsonAsync("/api/auth/login", new { email = "nobody-" + email, password }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        for (var i = 0; i < 5; i++)
        {
            (await client.PostAsJsonAsync("/api/auth/login", new { email, password = password + "x" }, HttpApiFixture.Json))
                .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }
        (await client.PostAsJsonAsync("/api/auth/login", new { email, password }, HttpApiFixture.Json))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var lines = logs.Security();
        lines.Should().Contain(l => l.StartsWith("Security event SignInFailed for login unknown") && l.Contains("no such login"));
        lines.Count(l => l.StartsWith($"Security event SignInFailed for login {userId} ")).Should().Be(4);
        lines.Should().ContainSingle(l => l.StartsWith($"Security event LockedOut for login {userId} "));
        lines.Should().ContainSingle(l => l.StartsWith($"Security event SignInWhileLocked for login {userId} "));
        lines.Should().OnlyContain(l => l.Contains(" on /api/auth/login"));
        logs.Lines.Should().NotContain(l => l.Message.Contains(email), "no log line carries the email address");
        lines.Should().NotContain(l => l.Contains("@"), "security lines never name an address, even masked");

        // A change on the account is recorded too (the lockout doesn't stop a signed-in session's
        // other actions, so sign out everywhere still works and is logged).
        (await HttpApiFixture.SendAsync(client, HttpMethod.Post, "/api/auth/sign-out-everywhere", token))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);
        logs.Security().Should().ContainSingle(l => l.StartsWith($"Security event SignedOutEverywhere for login {userId} "));
    }
}
