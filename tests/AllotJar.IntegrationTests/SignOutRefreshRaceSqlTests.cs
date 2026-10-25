using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// A refresh landing at the same moment as a sign-out (#380 review P3-2): sign-out, signing a device
/// out from the Devices list, and sign out everywhere each read the tokens and saved them revoked,
/// while the refresh read its token, saved it rotated and added the next one. Whichever saved last
/// won, so the refresh could outlive the sign-out with a fresh token. Now the sign-out always wins.
/// Also a refresh at its token's last instant losing the row to the purge (#382 review P3-4), which
/// failed with a 500 instead of a plain refusal.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class SignOutRefreshRaceSqlTests
{
    private readonly SqlServerFixture _fixture;

    public SignOutRefreshRaceSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static string Hash(string raw) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));

    private ApplicationDbContext Gated(CommandGate gate) =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>().UseSqlServer(_fixture.ConnectionString).AddInterceptors(gate).Options);

    /// <summary>
    /// Starts a refresh of <paramref name="raw"/> that reads its token and then waits, runs
    /// <paramref name="meanwhile"/> to the end on its own connection, then lets the refresh finish.
    /// </summary>
    private async Task<RefreshRotationResult> RefreshAroundAsync(string raw, Func<RefreshTokenService, Task> meanwhile)
    {
        var gate = CommandGate.FirstWrite();
        await using var db = Gated(gate);
        var refresh = Task.Run(() => new RefreshTokenService(db).RotateAsync(raw));
        await gate.Reached.Task;                       // the refresh has read its token, still active

        await using (var other = _fixture.CreateContext())
        {
            await meanwhile(new RefreshTokenService(other));
        }

        gate.Release.SetResult();
        return await refresh;
    }

    private async Task<int> ActiveCountAsync(string userId)
    {
        await using var db = _fixture.CreateContext();
        return await db.RefreshTokens.CountAsync(t => t.UserId == userId && t.RevokedUtc == null);
    }

    [Fact]
    public async Task Sign_out_landing_after_the_refresh_read_its_token_wins()
    {
        var (user, raw, _) = await SeedAsync();

        var refresh = await RefreshAroundAsync(raw, svc => svc.RevokeAsync(raw));

        refresh.Succeeded.Should().BeFalse("the sign-out came first, so the refresh has nothing to rotate");
        refresh.Superseded.Should().BeFalse("the cookie should be cleared: this device signed out");
        (await ActiveCountAsync(user)).Should().Be(0);
    }

    [Fact]
    public async Task Signing_the_device_out_from_the_devices_list_while_it_refreshes_wins()
    {
        var (user, raw, session) = await SeedAsync();

        var refresh = await RefreshAroundAsync(raw, async svc =>
            (await svc.RevokeSessionAsync(user, session)).Should().BeTrue());

        refresh.Succeeded.Should().BeFalse();
        (await ActiveCountAsync(user)).Should().Be(0);
    }

    [Fact]
    public async Task Sign_out_everywhere_while_a_device_refreshes_wins()
    {
        var (user, raw, _) = await SeedAsync();
        var otherDevice = await AddSessionAsync(user);

        var refresh = await RefreshAroundAsync(raw, svc => svc.RevokeAllForUserAsync(user));

        refresh.Succeeded.Should().BeFalse();
        (await ActiveCountAsync(user)).Should().Be(0);
        await using var db = _fixture.CreateContext();
        (await new RefreshTokenService(db).RotateAsync(otherDevice)).Succeeded.Should().BeFalse();
    }

    /// <summary>
    /// The refresh endpoint rotates inside a transaction and commits with its answer. A sign-out
    /// arriving while that transaction is open waits for it, then ends the token it minted; the
    /// refresh's check after its commit refuses it, so its cookie is never handed out.
    /// </summary>
    [Fact]
    public async Task Sign_out_landing_while_the_refresh_transaction_is_open_wins()
    {
        var (user, raw, _) = await SeedAsync();

        await using var db = _fixture.CreateContext();
        var svc = new RefreshTokenService(db);
        var tx = await db.Database.BeginTransactionAsync();
        var rotation = await svc.RotateAsync(raw);
        rotation.Succeeded.Should().BeTrue();

        var signOut = Task.Run(async () =>
        {
            await using var other = _fixture.CreateContext();
            return await new RefreshTokenService(other).RevokeAsync(raw);
        });
        await Task.Delay(500);                         // the sign-out is now waiting on the open rotation
        await tx.CommitAsync();
        (await signOut).Should().Be(user);

        (await svc.ConfirmAsync(rotation.NewRawToken!)).Should().BeFalse();
        (await ActiveCountAsync(user)).Should().Be(0);
        (await svc.RotateAsync(rotation.NewRawToken!)).Succeeded.Should().BeFalse();
    }

    /// <summary>
    /// The case the check after commit exists for: the sign-out marked the sign-in, but its revoke
    /// ran before the refresh's new token was saved, so the new token is still active.
    /// </summary>
    [Fact]
    public async Task A_new_token_the_sign_outs_revoke_missed_is_refused_and_revoked_by_the_check()
    {
        var (user, raw, session) = await SeedAsync();
        await using var db = _fixture.CreateContext();
        var svc = new RefreshTokenService(db);
        var rotation = await svc.RotateAsync(raw);
        rotation.Succeeded.Should().BeTrue();

        // The sign-out's mark, without its revoke reaching the new token.
        await db.RefreshTokens.Where(t => t.TokenHash == Hash(raw))
            .ExecuteUpdateAsync(u => u.SetProperty(t => t.SignedOutUtc, DateTime.UtcNow));

        (await svc.ConfirmAsync(rotation.NewRawToken!)).Should().BeFalse();
        (await ActiveCountAsync(user)).Should().Be(0);
        (await db.RefreshTokens.AnyAsync(t => t.SessionId == session && t.SignedOutUtc == null)).Should().BeFalse();
    }

    [Fact]
    public async Task A_refresh_with_no_sign_out_is_confirmed()
    {
        var (user, raw, _) = await SeedAsync();
        await using var db = _fixture.CreateContext();
        var svc = new RefreshTokenService(db);

        var rotation = await svc.RotateAsync(raw);

        (await svc.ConfirmAsync(rotation.NewRawToken!)).Should().BeTrue();
        (await ActiveCountAsync(user)).Should().Be(1);
    }

    [Fact]
    public async Task Two_tabs_racing_the_same_cookie_both_carry_on()
    {
        var (user, raw, _) = await SeedAsync();
        RefreshRotationResult? first = null;

        var second = await RefreshAroundAsync(raw, async svc => first = await svc.RotateAsync(raw));

        first!.Succeeded.Should().BeTrue();
        second.Succeeded.Should().BeTrue("a sibling tab's rotation is not a sign-out");
        await using var db = _fixture.CreateContext();
        var svc = new RefreshTokenService(db);
        (await svc.ConfirmAsync(first.NewRawToken!)).Should().BeTrue();
        (await svc.ConfirmAsync(second.NewRawToken!)).Should().BeTrue();
        (await ActiveCountAsync(user)).Should().Be(2);
    }

    [Fact]
    public async Task A_refresh_whose_token_the_purge_deletes_meanwhile_is_refused_not_an_error()
    {
        var (user, raw, _) = await SeedAsync();

        var refresh = await RefreshAroundAsync(raw, async _ =>
        {
            // The purge (or another device's prune) taking the row at the token's last instant.
            await using var db = _fixture.CreateContext();
            await db.RefreshTokens.Where(t => t.TokenHash == Hash(raw)).ExecuteDeleteAsync();
        });

        refresh.Succeeded.Should().BeFalse();
        (await ActiveCountAsync(user)).Should().Be(0);
    }

    [Fact]
    public async Task Sign_out_everywhere_is_no_error_when_the_purge_takes_an_expired_token_meanwhile()
    {
        var (user, _, _) = await SeedAsync();
        var expired = "expired-" + Guid.NewGuid();
        await using (var seed = _fixture.CreateContext())
        {
            var now = DateTime.UtcNow;
            seed.RefreshTokens.Add(new RefreshToken
            {
                UserId = user, TokenHash = Hash(expired), CreatedUtc = now.AddDays(-31), ExpiresUtc = now.AddMinutes(-1),
                SessionId = Guid.NewGuid(), SessionStartedUtc = now.AddDays(-31),
            });
            await seed.SaveChangesAsync();
        }

        var gate = CommandGate.FirstWrite();
        await using var db = Gated(gate);
        var signOut = Task.Run(() => new RefreshTokenService(db).RevokeAllForUserAsync(user));
        await gate.Reached.Task;
        await using (var purge = _fixture.CreateContext())
        {
            await purge.RefreshTokens.Where(t => t.TokenHash == Hash(expired)).ExecuteDeleteAsync();
        }
        gate.Release.SetResult();

        await FluentActions.Awaiting(() => signOut).Should().NotThrowAsync();
        (await ActiveCountAsync(user)).Should().Be(0);
    }

    private async Task<(string User, string Raw, Guid Session)> SeedAsync()
    {
        var user = $"user-{Guid.NewGuid():N}";
        var raw = "device-" + Guid.NewGuid();
        var session = await AddSessionAsync(user, raw);
        return (user, raw, session);
    }

    private async Task<string> AddSessionAsync(string user)
    {
        var raw = "device-" + Guid.NewGuid();
        await AddSessionAsync(user, raw);
        return raw;
    }

    private async Task<Guid> AddSessionAsync(string user, string raw)
    {
        await using var db = _fixture.CreateContext();
        var now = DateTime.UtcNow;
        var session = Guid.NewGuid();
        db.RefreshTokens.Add(new RefreshToken
        {
            UserId = user, TokenHash = Hash(raw), CreatedUtc = now.AddMinutes(-15), ExpiresUtc = now.AddDays(29),
            SessionId = session, SessionStartedUtc = now.AddDays(-1),
        });
        await db.SaveChangesAsync();
        return session;
    }
}
