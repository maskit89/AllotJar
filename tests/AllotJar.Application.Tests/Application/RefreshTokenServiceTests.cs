using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Refresh-token issue / rotate / revoke, including rotation (old token dies, new one works) and
/// reuse detection (replaying a rotated token burns the whole chain — the theft response), with a
/// short grace window so concurrent tabs racing the same cookie aren't mistaken for theft.
/// </summary>
public class RefreshTokenServiceTests
{
    [Fact]
    public async Task Rotate_revokes_the_old_token_and_issues_a_new_one()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw);

        rot.Succeeded.Should().BeTrue();
        rot.UserId.Should().Be("user-1");
        rot.NewRawToken.Should().NotBeNullOrWhiteSpace();
        rot.NewRawToken.Should().NotBe(raw);

        var tokens = await db.RefreshTokens.ToListAsync();
        tokens.Should().HaveCount(2);
        tokens.Count(t => t.RevokedUtc == null).Should().Be(1); // only the replacement is active
    }

    [Fact]
    public async Task Rotation_chains_so_the_latest_token_keeps_working()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var rot1 = await svc.RotateAsync(raw);
        var rot2 = await svc.RotateAsync(rot1.NewRawToken!);

        rot2.Succeeded.Should().BeTrue();
        rot2.NewRawToken.Should().NotBe(rot1.NewRawToken);
    }

    [Fact]
    public async Task Replaying_a_token_rotated_outside_the_grace_window_burns_the_whole_chain()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw); // raw revoked, replacement active

        // Age the rotation past the grace window — this replay can't be a sibling tab.
        var rotated = await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(raw));
        rotated.RevokedUtc = DateTime.UtcNow - RefreshTokenService.ReplayGraceWindow - TimeSpan.FromSeconds(1);
        await db.SaveChangesAsync();

        // Replaying the long-rotated token is treated as theft.
        var replay = await svc.RotateAsync(raw);
        replay.Succeeded.Should().BeFalse();
        replay.Superseded.Should().BeFalse();

        // ...which also revokes the still-active replacement.
        (await svc.RotateAsync(rot.NewRawToken!)).Succeeded.Should().BeFalse();
        (await db.RefreshTokens.CountAsync(t => t.RevokedUtc == null)).Should().Be(0);
    }

    [Fact]
    public async Task Replaying_a_just_rotated_token_is_refused_without_burning_the_chain()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        // Two restored tabs race /auth/refresh with the same cookie: the first rotates it, the
        // second presents the now-rotated value moments later.
        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw);
        var replay = await svc.RotateAsync(raw);

        // The loser is refused — but flagged so the controller keeps the winner's cookie...
        replay.Succeeded.Should().BeFalse();
        replay.Superseded.Should().BeTrue();

        // ...and the winner's session is untouched: no burn, its token still rotates.
        (await db.RefreshTokens.CountAsync(t => t.RevokedUtc == null)).Should().Be(1);
        (await svc.RotateAsync(rot.NewRawToken!)).Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task Repeated_replays_within_the_grace_window_stay_refused_without_burning()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        // A browser restoring THREE tabs: one winner, two losers presenting the same old cookie.
        var raw = await svc.IssueAsync("user-1");
        await svc.RotateAsync(raw);

        (await svc.RotateAsync(raw)).Superseded.Should().BeTrue();
        (await svc.RotateAsync(raw)).Superseded.Should().BeTrue();
        (await db.RefreshTokens.CountAsync(t => t.RevokedUtc == null)).Should().Be(1);
    }

    [Fact]
    public async Task An_expired_token_is_rejected()
    {
        using var db = NewContext();
        db.RefreshTokens.Add(new RefreshToken
        {
            UserId = "user-1",
            TokenHash = HashFor("expired-raw"),
            CreatedUtc = DateTime.UtcNow.AddDays(-40),
            ExpiresUtc = DateTime.UtcNow.AddDays(-1),
        });
        await db.SaveChangesAsync();

        (await new RefreshTokenService(db).RotateAsync("expired-raw")).Succeeded.Should().BeFalse();
    }

    [Fact]
    public async Task Revoke_then_rotate_fails()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        await svc.RevokeAsync(raw);

        (await svc.RotateAsync(raw)).Succeeded.Should().BeFalse();
    }

    [Fact]
    public async Task Revoke_returns_the_owning_user_so_logout_can_kill_their_access_tokens()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");

        (await svc.RevokeAsync(raw)).Should().Be("user-1");
        // Already revoked still names the owner — signing out twice still ends the session.
        (await svc.RevokeAsync(raw)).Should().Be("user-1");
        (await svc.RevokeAsync("never-issued")).Should().BeNull();
        (await svc.RevokeAsync("")).Should().BeNull();
    }

    [Fact]
    public async Task Replaying_an_administratively_revoked_token_is_refused_without_the_theft_response()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        // Password change: every device's token is revoked, then THIS device gets a fresh one.
        var stale = await svc.IssueAsync("user-1");
        await svc.RevokeAllForUserAsync("user-1");
        var fresh = await svc.IssueAsync("user-1");

        // The stale device checking back in is refused — but it must NOT burn the new session
        // (only a ROTATED token replayed is theft; an admin-revoked one is just signed out).
        // It's not "superseded" either, even though the revocation is recent: there is no
        // replacement in that device's jar, so the controller SHOULD clear its cookie.
        var replay = await svc.RotateAsync(stale);
        replay.Succeeded.Should().BeFalse();
        replay.Superseded.Should().BeFalse();
        (await svc.RotateAsync(fresh)).Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task RevokeAllForUser_ends_the_session_on_every_device_but_leaves_other_users_alone()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        // Two devices for user-1 (e.g. laptop + phone), one for user-2.
        var laptop = await svc.IssueAsync("user-1");
        var phone = await svc.IssueAsync("user-1");
        var other = await svc.IssueAsync("user-2");

        await svc.RevokeAllForUserAsync("user-1");

        (await svc.RotateAsync(laptop)).Succeeded.Should().BeFalse();
        (await svc.RotateAsync(phone)).Succeeded.Should().BeFalse();
        (await svc.RotateAsync(other)).Succeeded.Should().BeTrue(); // user-2 unaffected
    }

    [Fact]
    public async Task An_unknown_token_is_rejected()
    {
        using var db = NewContext();
        (await new RefreshTokenService(db).RotateAsync("never-issued")).Succeeded.Should().BeFalse();
    }

    private static string HashFor(string raw) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
}
