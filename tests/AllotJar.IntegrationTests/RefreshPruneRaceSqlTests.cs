using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Follow-ups F2 (S-P3-1, PR #303 review P2-1): two refreshes of the same login that both read the
/// login's expired tokens before either saves. Pruning deletes set-based, so the second refresh
/// finding the rows already gone is no conflict; a tracked delete affected 0 rows and failed with
/// a 409, signing that tab or device out.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class RefreshPruneRaceSqlTests
{
    private readonly SqlServerFixture _fixture;

    public RefreshPruneRaceSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    /// <summary>Holds the first SaveChanges of its context until released.</summary>
    private sealed class SaveGate : SaveChangesInterceptor
    {
        public readonly TaskCompletionSource Reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource Release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _calls;

        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref _calls) == 1)
            {
                Reached.SetResult();
                await Release.Task;
            }
            return result;
        }
    }

    private static string Hash(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));

    private ApplicationDbContext Gated(SaveGate gate) =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>().UseSqlServer(_fixture.ConnectionString).AddInterceptors(gate).Options);

    private async Task<Exception?> RaceAsync(string rawA, string rawB)
    {
        var gate = new SaveGate();
        await using var dbB = Gated(gate);
        var b = Task.Run(() => new RefreshTokenService(dbB).RotateAsync(rawB));
        await gate.Reached.Task;                       // B has read its token and the expired list

        await using (var dbA = _fixture.CreateContext())
        {
            var a = await new RefreshTokenService(dbA).RotateAsync(rawA);
            a.Succeeded.Should().BeTrue();             // A rotates and commits first
        }

        gate.Release.SetResult();
        try
        {
            var result = await b;
            result.Succeeded.Should().BeTrue();
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    [Fact]
    public async Task Two_devices_refreshing_together_both_succeed_when_an_expired_token_exists()
    {
        var raw1 = "device-1-" + Guid.NewGuid();
        var raw2 = "device-2-" + Guid.NewGuid();
        await SeedAsyncFor(raw1, raw2, withExpired: true);

        var failure = await RaceAsync(raw1, raw2);

        failure.Should().BeNull("a second device's refresh should not fail because the first pruned the same expired row");
    }

    [Fact]
    public async Task Two_tabs_restoring_with_the_same_cookie_both_succeed_when_an_expired_token_exists()
    {
        var raw = "tab-" + Guid.NewGuid();
        await SeedAsyncFor(raw, null, withExpired: true);

        var failure = await RaceAsync(raw, raw);

        failure.Should().BeNull("before the PR the losing tab's rotation saved (both tabs stay signed in)");
    }

    [Fact]
    public async Task The_same_race_with_no_expired_token_succeeds()
    {
        var raw1 = "device-1-" + Guid.NewGuid();
        var raw2 = "device-2-" + Guid.NewGuid();
        await SeedAsyncFor(raw1, raw2, withExpired: false);

        var failure = await RaceAsync(raw1, raw2);

        failure.Should().BeNull();
    }

    private async Task SeedAsyncFor(string raw1, string? raw2, bool withExpired)
    {
        var user = $"user-{Guid.NewGuid():N}";
        await using var db = _fixture.CreateContext();
        var now = DateTime.UtcNow;
        if (withExpired)
        {
            db.RefreshTokens.Add(new RefreshToken
            {
                UserId = user, TokenHash = Hash(Guid.NewGuid().ToString()), CreatedUtc = now.AddDays(-31),
                ExpiresUtc = now.AddMinutes(-5), RevokedUtc = now.AddDays(-31), ReplacedByTokenHash = "x",
            });
        }
        foreach (var raw in new[] { raw1, raw2 }.Where(r => r is not null).Distinct())
        {
            db.RefreshTokens.Add(new RefreshToken
            {
                UserId = user, TokenHash = Hash(raw!), CreatedUtc = now.AddMinutes(-15), ExpiresUtc = now.AddDays(29),
                SessionId = Guid.NewGuid(), SessionStartedUtc = now.AddDays(-1),
            });
        }
        await db.SaveChangesAsync();
    }
}
