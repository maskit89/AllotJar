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

    [Fact]
    public async Task A_rotation_keeps_the_sign_in_its_start_and_its_device()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1", "Safari on iPhone");
        var first = await db.RefreshTokens.SingleAsync();
        var rot = await svc.RotateAsync(raw, "Chrome on Windows");

        var next = await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(rot.NewRawToken!));
        next.SessionId.Should().Be(first.SessionId);
        next.SessionStartedUtc.Should().Be(first.SessionStartedUtc);
        next.Device.Should().Be("Safari on iPhone", "the sign-in was made there; a later refresh doesn't rename it");
        rot.ExpiresUtc.Should().Be(next.ExpiresUtc);
    }

    [Fact]
    public async Task A_sign_in_from_before_devices_were_recorded_learns_its_device_at_its_next_refresh()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw, "AllotJar app on iPhone");

        (await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(rot.NewRawToken!)))
            .Device.Should().Be("AllotJar app on iPhone");
    }

    [Fact]
    public async Task Each_sign_in_is_a_session_of_its_own()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        await svc.IssueAsync("user-1");
        await svc.IssueAsync("user-1");

        (await db.RefreshTokens.Select(t => t.SessionId).Distinct().CountAsync()).Should().Be(2);
    }

    [Fact]
    public async Task A_token_is_renewed_for_30_days_but_never_past_the_sign_ins_90th_day()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var token = await db.RefreshTokens.SingleAsync();
        // The sign-in began 80 days ago: a refresh now may run 10 more days, not 30.
        var started = DateTime.UtcNow.AddDays(-80);
        token.SessionStartedUtc = started;
        await db.SaveChangesAsync();

        var rot = await svc.RotateAsync(raw);

        rot.Succeeded.Should().BeTrue();
        rot.ExpiresUtc.Should().Be(started.AddDays(RefreshTokenService.MaxSessionDays));
    }

    [Fact]
    public async Task A_sign_in_older_than_90_days_is_refused_however_recently_it_was_used()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        // A token minted before the cap existed: still within its own 30 days, but its sign-in is old.
        var raw = await svc.IssueAsync("user-1");
        var token = await db.RefreshTokens.SingleAsync();
        token.SessionStartedUtc = DateTime.UtcNow.AddDays(-RefreshTokenService.MaxSessionDays).AddMinutes(-1);
        await db.SaveChangesAsync();

        var rot = await svc.RotateAsync(raw);

        rot.Succeeded.Should().BeFalse();
        rot.Superseded.Should().BeFalse("the device is signed out, so its cookie is cleared");
    }

    [Fact]
    public async Task The_list_has_one_row_per_device_this_one_first_and_only_the_logins_own()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var laptop = await svc.IssueAsync("user-1", "Chrome on Windows");
        var phone = await svc.IssueAsync("user-1", "AllotJar app on iPhone");
        var signedOut = await svc.IssueAsync("user-1", "Safari on Mac");
        await svc.RevokeAsync(signedOut);
        await svc.IssueAsync("user-2", "Firefox on Linux");
        // The laptop refreshed twice: still one device.
        var rot = await svc.RotateAsync(laptop);
        await svc.RotateAsync(rot.NewRawToken!);

        var list = await svc.ListActiveAsync("user-1", phone);

        list.Select(s => s.Device).Should().Equal("AllotJar app on iPhone", "Chrome on Windows");
        list.Select(s => s.Current).Should().Equal(true, false);
    }

    [Fact]
    public async Task Without_a_cookie_no_device_is_marked_current()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);
        await svc.IssueAsync("user-1", "Chrome on Windows");

        (await svc.ListActiveAsync("user-1", null)).Should().ContainSingle().Which.Current.Should().BeFalse();
    }

    [Fact]
    public async Task Ending_one_sign_in_leaves_the_others_and_never_reaches_another_login()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var laptop = await svc.IssueAsync("user-1", "Chrome on Windows");
        var phone = await svc.IssueAsync("user-1", "Safari on iPhone");
        var other = await svc.IssueAsync("user-2", "Safari on iPhone");
        var phoneSession = (await svc.ListActiveAsync("user-1", phone)).Single(s => s.Current).Id;
        var otherSession = (await svc.ListActiveAsync("user-2", other)).Single().Id;

        (await svc.RevokeSessionAsync("user-1", otherSession)).Should().BeFalse("it belongs to someone else");
        (await svc.RevokeSessionAsync("user-1", phoneSession)).Should().BeTrue();
        (await svc.RevokeSessionAsync("user-1", phoneSession)).Should().BeFalse("it has already ended");

        (await svc.RotateAsync(phone)).Succeeded.Should().BeFalse();
        (await svc.RotateAsync(laptop)).Succeeded.Should().BeTrue();
        (await svc.RotateAsync(other)).Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task Signing_out_with_a_cookie_a_refresh_just_rotated_ends_the_whole_sign_in()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var laptop = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw);   // the refresh won; the sign-out still sends the old cookie

        (await svc.RevokeAsync(raw)).Should().Be("user-1");

        (await svc.RotateAsync(rot.NewRawToken!)).Succeeded.Should().BeFalse("the replacement belongs to the same sign-in");
        (await svc.RotateAsync(laptop)).Succeeded.Should().BeTrue("another device's sign-in is not touched");
    }

    [Fact]
    public async Task A_rotated_cookie_of_a_signed_out_sign_in_is_refused_without_the_theft_response()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var laptop = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw);
        await svc.RevokeAsync(rot.NewRawToken!);
        var rotated = await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(raw));
        rotated.RevokedUtc = DateTime.UtcNow - RefreshTokenService.ReplayGraceWindow - TimeSpan.FromSeconds(1);
        await db.SaveChangesAsync();

        var replay = await svc.RotateAsync(raw);

        replay.Succeeded.Should().BeFalse();
        replay.Superseded.Should().BeFalse();
        (await svc.RotateAsync(laptop)).Succeeded.Should().BeTrue("the sign-out already ended that sign-in, so nothing else is burned");
    }

    [Fact]
    public async Task Confirm_passes_a_rotation_no_sign_out_reached()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var rot = await svc.RotateAsync(await svc.IssueAsync("user-1"));

        (await svc.ConfirmAsync(rot.NewRawToken!)).Should().BeTrue();
        (await svc.RotateAsync(rot.NewRawToken!)).Succeeded.Should().BeTrue();
    }

    [Fact]
    public async Task Confirm_refuses_and_ends_a_new_token_whose_sign_in_was_signed_out_meanwhile()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);
        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw);

        // The sign-out marked the sign-in, but its revoke ran before the new token was saved.
        (await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(raw))).SignedOutUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();

        (await svc.ConfirmAsync(rot.NewRawToken!)).Should().BeFalse();
        (await db.RefreshTokens.CountAsync(t => t.RevokedUtc == null)).Should().Be(0);
    }

    [Fact]
    public async Task Confirm_refuses_an_unknown_token()
    {
        using var db = NewContext();

        (await new RefreshTokenService(db).ConfirmAsync("never-issued")).Should().BeFalse();
    }

    [Fact]
    public async Task A_sign_in_marked_signed_out_is_not_listed_even_if_its_revoke_never_ran()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);
        var raw = await svc.IssueAsync("user-1");
        var laptop = await svc.IssueAsync("user-1");

        // The process stopped between the sign-out's mark and its revoke.
        (await db.RefreshTokens.SingleAsync(t => t.TokenHash == HashFor(raw))).SignedOutUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();

        (await svc.ListActiveAsync("user-1", laptop)).Should().ContainSingle().Which.Current.Should().BeTrue();
        (await svc.RotateAsync(raw)).Succeeded.Should().BeFalse();
    }

    private static string HashFor(string raw) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
}
