using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Identity;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Refresh-token issue / rotate / revoke, including rotation (old token dies, new one works) and
/// reuse detection (replaying a rotated token burns the whole chain — the theft response).
/// </summary>
public class RefreshTokenServiceTests
{
    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-rt-{Guid.NewGuid()}")
            .Options);

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
    public async Task Replaying_a_rotated_token_burns_the_whole_chain()
    {
        using var db = NewContext();
        var svc = new RefreshTokenService(db);

        var raw = await svc.IssueAsync("user-1");
        var rot = await svc.RotateAsync(raw); // raw revoked, replacement active

        // Replaying the already-rotated token is treated as theft.
        (await svc.RotateAsync(raw)).Succeeded.Should().BeFalse();

        // ...which also revokes the still-active replacement.
        (await svc.RotateAsync(rot.NewRawToken!)).Succeeded.Should().BeFalse();
        (await db.RefreshTokens.CountAsync(t => t.RevokedUtc == null)).Should().Be(0);
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
    public async Task An_unknown_token_is_rejected()
    {
        using var db = NewContext();
        (await new RefreshTokenService(db).RotateAsync("never-issued")).Succeeded.Should().BeFalse();
    }

    private static string HashFor(string raw) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)));
}
