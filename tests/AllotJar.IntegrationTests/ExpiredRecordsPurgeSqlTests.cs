using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Retention;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Compliance fix 9 on the real schema: the purge's set-based deletes translate to SQL and remove
/// only expired tokens and long-expired invitations. The database is shared with the rest of the
/// collection, so the test checks its own rows only.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class ExpiredRecordsPurgeSqlTests
{
    private readonly SqlServerFixture _fixture;

    public ExpiredRecordsPurgeSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Deletes_expired_tokens_and_long_expired_invitations_and_keeps_the_rest()
    {
        var owner = $"owner-{Guid.NewGuid():N}";
        var now = DateTime.UtcNow;
        await using (var db = _fixture.CreateContext())
        {
            db.RefreshTokens.AddRange(
                new RefreshToken { UserId = owner, TokenHash = $"gone-{owner}", CreatedUtc = now.AddDays(-31), ExpiresUtc = now.AddDays(-1) },
                new RefreshToken { UserId = owner, TokenHash = $"kept-{owner}", CreatedUtc = now.AddDays(-1), ExpiresUtc = now.AddDays(29), RevokedUtc = now.AddDays(-1) });
            db.HouseholdMemberships.AddRange(
                new HouseholdMembership { OwnerId = owner, Role = HouseholdRole.ReadOnly, Status = MembershipStatus.Invited, InvitedEmail = "old@example.com", InviteTokenHash = $"old-{owner}", InviteExpiresUtc = now.AddDays(-31) },
                new HouseholdMembership { OwnerId = owner, Role = HouseholdRole.ReadOnly, Status = MembershipStatus.Invited, InvitedEmail = "recent@example.com", InviteTokenHash = $"recent-{owner}", InviteExpiresUtc = now.AddDays(-2) },
                new HouseholdMembership { OwnerId = owner, UserId = owner, Role = HouseholdRole.Owner, Status = MembershipStatus.Active, InvitedEmail = "me@example.com" });
            await db.SaveChangesAsync();
        }

        await using (var db = _fixture.CreateContext())
        {
            var result = await new ExpiredRecordsPurge(db).RunAsync(now);
            result.RefreshTokens.Should().BeGreaterThanOrEqualTo(1);
            result.Invitations.Should().BeGreaterThanOrEqualTo(1);
        }

        await using (var db = _fixture.CreateContext())
        {
            (await db.RefreshTokens.Where(t => t.UserId == owner).Select(t => t.TokenHash).ToListAsync())
                .Should().Equal($"kept-{owner}");
            (await db.HouseholdMemberships.Where(m => m.OwnerId == owner).Select(m => m.InvitedEmail).ToListAsync())
                .Should().BeEquivalentTo("recent@example.com", "me@example.com");
        }
    }
}
