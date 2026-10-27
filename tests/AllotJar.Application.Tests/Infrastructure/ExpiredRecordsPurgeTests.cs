using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Retention;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// Compliance fix 9: the daily purge deletes expired sign-in tokens and invitations nobody accepted
/// within 30 days of their link expiring, for every login, and keeps everything still in use.
/// </summary>
public class ExpiredRecordsPurgeTests
{
    private static readonly DateTime Now = new(2026, 10, 20, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public async Task Deletes_expired_tokens_of_every_login_and_keeps_unexpired_ones()
    {
        using var db = NewContext();
        db.RefreshTokens.AddRange(
            Token("gone-a", "user-1", expires: Now.AddDays(-1)),
            Token("gone-b", "user-2", expires: Now.AddSeconds(-1), revoked: Now.AddDays(-20)),
            Token("active", "user-1", expires: Now.AddDays(10)),
            // Rotated but not yet expired: kept, so replaying it still meets the theft response.
            Token("rotated", "user-2", expires: Now.AddDays(5), revoked: Now.AddDays(-25), replacedBy: "active"));
        await db.SaveChangesAsync();

        var result = await new ExpiredRecordsPurge(db).RunAsync(Now);

        result.RefreshTokens.Should().Be(2);
        (await db.RefreshTokens.Select(t => t.TokenHash).ToListAsync())
            .Should().BeEquivalentTo("active", "rotated");
    }

    [Fact]
    public async Task Deletes_an_unaccepted_invitation_30_days_after_its_link_expired()
    {
        using var db = NewContext();
        var old = Invite("old@example.com", expires: Now.AddDays(-ExpiredRecordsPurge.InviteGraceDays).AddMinutes(-1));
        var recent = Invite("recent@example.com", expires: Now.AddDays(-ExpiredRecordsPurge.InviteGraceDays).AddMinutes(1));
        var live = Invite("live@example.com", expires: Now.AddDays(3));
        var accepted = new HouseholdMembership
        {
            OwnerId = "owner-1", UserId = "user-2", Role = HouseholdRole.Admin, Status = MembershipStatus.Active,
            InvitedEmail = "sam@example.com",
        };
        db.HouseholdMemberships.AddRange(old, recent, live, accepted);
        await db.SaveChangesAsync();

        var result = await new ExpiredRecordsPurge(db).RunAsync(Now);

        result.Invitations.Should().Be(1);
        (await db.HouseholdMemberships.Select(m => m.InvitedEmail).ToListAsync())
            .Should().BeEquivalentTo("recent@example.com", "live@example.com", "sam@example.com");
    }

    [Fact]
    public async Task A_second_run_finds_nothing_left()
    {
        using var db = NewContext();
        db.RefreshTokens.Add(Token("gone", "user-1", expires: Now.AddDays(-1)));
        db.HouseholdMemberships.Add(Invite("old@example.com", expires: Now.AddDays(-40)));
        await db.SaveChangesAsync();

        var purge = new ExpiredRecordsPurge(db);
        await purge.RunAsync(Now);

        (await purge.RunAsync(Now)).Should().Be(new PurgeResult(0, 0));
    }

    [Fact]
    public async Task A_failed_run_is_logged_as_an_error_and_does_not_stop_the_service()
    {
        var services = new ServiceCollection();
        // No database registered: resolving the purge throws, as a database that is down would.
        services.AddScoped<ExpiredRecordsPurge>();
        var logger = new ListLogger();
        var service = new ExpiredRecordsPurgeService(
            services.BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(), TimeProvider.System, logger, new DatabaseStartupGate());

        await service.Invoking(s => s.RunOnceAsync(CancellationToken.None)).Should().NotThrowAsync();

        logger.Levels.Should().Equal(LogLevel.Error);
    }

    [Fact]
    public async Task A_run_logs_how_many_rows_it_deleted()
    {
        var name = $"purge-{Guid.NewGuid()}";
        var services = new ServiceCollection();
        services.AddDbContext<ApplicationDbContext>(o => o.UseInMemoryDatabase(name));
        services.AddScoped<ExpiredRecordsPurge>();
        var provider = services.BuildServiceProvider();
        using (var scope = provider.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            db.RefreshTokens.Add(Token("gone", "user-1", expires: DateTime.UtcNow.AddDays(-1)));
            await db.SaveChangesAsync();
        }
        var logger = new ListLogger();

        await new ExpiredRecordsPurgeService(provider.GetRequiredService<IServiceScopeFactory>(), TimeProvider.System, logger, new DatabaseStartupGate())
            .RunOnceAsync(CancellationToken.None);

        logger.Levels.Should().Equal(LogLevel.Information);
        logger.Messages.Single().Should().Contain("deleted 1 expired sign-in tokens and 0 expired invitations");
    }

    private static RefreshToken Token(string hash, string userId, DateTime expires, DateTime? revoked = null, string? replacedBy = null) =>
        new()
        {
            UserId = userId,
            TokenHash = hash,
            CreatedUtc = expires.AddDays(-30),
            ExpiresUtc = expires,
            RevokedUtc = revoked,
            ReplacedByTokenHash = replacedBy,
        };

    private static HouseholdMembership Invite(string email, DateTime expires) =>
        new()
        {
            OwnerId = "owner-1",
            Role = HouseholdRole.ReadOnly,
            Status = MembershipStatus.Invited,
            InvitedEmail = email,
            InviteTokenHash = $"hash-{email}",
            InviteExpiresUtc = expires,
        };

    private sealed class ListLogger : ILogger<ExpiredRecordsPurgeService>
    {
        public List<LogLevel> Levels { get; } = new();
        public List<string> Messages { get; } = new();

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => NullLogger.Instance.BeginScope(state);
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            Levels.Add(logLevel);
            Messages.Add(formatter(state, exception));
        }
    }
}
