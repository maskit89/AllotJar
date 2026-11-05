using System.Collections.Concurrent;
using System.Net;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Logging;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Logging;

/// <summary>The security log (audit A09-001): what a line carries, the rate-limit throttle, and the refresh-token theft response.</summary>
public class SecurityEventsTests
{
    internal sealed class CapturedLogs : ILoggerProvider
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
    }

    private sealed class Clock : TimeProvider
    {
        // The throttle reads the monotonic timestamp, so the test moves that, not the wall clock.
        public TimeSpan Elapsed { get; set; } = TimeSpan.FromHours(1);

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Elapsed.Ticks;
    }

    internal static (SecurityEvents Events, CapturedLogs Logs) NewLog(TimeProvider? clock = null)
    {
        var logs = new CapturedLogs();
        var factory = LoggerFactory.Create(b => b.AddProvider(logs).SetMinimumLevel(LogLevel.Trace));
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.7");
        context.Request.Path = "/api/auth/login%0Aforged";
        context.SetEndpoint(new RouteEndpoint(_ => Task.CompletedTask, RoutePatternFactory.Parse("api/auth/login"), 0, null, null));
        return (new SecurityEvents(factory, new HttpContextAccessor { HttpContext = context }, clock), logs);
    }

    [Fact]
    public void A_line_is_a_warning_naming_the_event_the_login_the_address_and_the_path()
    {
        var (events, logs) = NewLog();

        events.Write(SecurityEvent.LockedOut, "user-42");

        var line = logs.Lines.Should().ContainSingle().Subject;
        line.Category.Should().Be(SecurityEvents.Category);
        line.Level.Should().Be(LogLevel.Warning);
        line.Message.Should().Be("Security event LockedOut for login user-42 from 203.0.113.7 on api/auth/login", "the route's pattern is logged, never the visitor's path");
    }

    [Fact]
    public void Rate_limit_refusals_are_logged_at_most_once_every_ten_seconds_with_a_count()
    {
        var clock = new Clock();
        var (events, logs) = NewLog(clock);

        for (var i = 0; i < 50; i++)
        {
            events.WriteRateLimited();
        }
        logs.Lines.Should().ContainSingle().Which.Message.Should().Contain("(1 turned away from all addresses since the last line)");

        clock.Elapsed += SecurityEvents.RateLimitedLogInterval - TimeSpan.FromTicks(1);
        events.WriteRateLimited();
        logs.Lines.Should().ContainSingle("the interval hasn't passed yet");

        clock.Elapsed += TimeSpan.FromTicks(1);
        events.WriteRateLimited();
        logs.Lines.Should().HaveCount(2);
        logs.Lines.Last().Message.Should().Contain("(51 turned away from all addresses since the last line)");
    }

    [Fact]
    public async Task A_replayed_refresh_token_is_logged_with_the_login_it_belonged_to()
    {
        var (events, logs) = NewLog();
        using var db = new ApplicationDbContext(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString()).Options);
        var svc = new RefreshTokenService(db, events);

        var raw = await svc.IssueAsync("user-1");
        await svc.RotateAsync(raw);
        var rotated = await db.RefreshTokens.SingleAsync(t => t.RevokedUtc != null);
        rotated.RevokedUtc = DateTime.UtcNow - RefreshTokenService.ReplayGraceWindow - TimeSpan.FromSeconds(1);
        await db.SaveChangesAsync();
        logs.Lines.Should().BeEmpty();

        (await svc.RotateAsync(raw)).Succeeded.Should().BeFalse();

        logs.Lines.Should().ContainSingle().Which.Message.Should()
            .StartWith("Security event RefreshTokenReplayed for login user-1 from 203.0.113.7");
    }
}
