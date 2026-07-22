using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Auth.Commands.Login;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The login command: how each credential-check outcome maps to a result, and that a JWT is only
/// ever minted on success — never for a locked-out or invalid attempt — with the role resolved
/// from the caller's active household membership.
/// </summary>
public class LoginTests
{
    private const string Email = "alex@x.com";
    private const string UserId = "user-1";

    private sealed class StubIdentity : IIdentityService
    {
        private readonly CredentialCheckResult _result;
        public StubIdentity(CredentialCheckResult result) => _result = result;

        public Task<CredentialCheckResult> CheckCredentialsAsync(string email, string password) =>
            Task.FromResult(_result);

        public Task<bool> EmailExistsAsync(string email) => Task.FromResult(false);
        public Task<UserAccount?> FindByEmailAsync(string email) => Task.FromResult<UserAccount?>(null);
        public Task<UserAccount?> FindByIdAsync(string userId) => Task.FromResult<UserAccount?>(null);
        public Task<CurrencyCode?> GetPreferredCurrencyAsync(string userId) =>
            Task.FromResult<CurrencyCode?>(null); // no preference -> callers use the EUR default
        public Task<CreateUserResult> CreateUserAsync(
            string email, string password, string? displayName, bool consented = false) =>
            Task.FromResult(CreateUserResult.Success("x"));
        public Task SetActiveHouseholdAsync(string userId, string? ownerId) => Task.CompletedTask;
        public Task<IReadOnlyList<string>> ChangePasswordAsync(string userId, string current, string next) =>
            Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());
    }

    private sealed class StubTokenGenerator : IJwtTokenGenerator
    {
        public (string Token, DateTime ExpiresAtUtc) Generate(string userId, string email, string? securityStamp) =>
            ($"token-for-{userId}", DateTime.UtcNow.AddMinutes(30));
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-login-{Guid.NewGuid()}")
            .Options);

    [Fact]
    public async Task Locked_out_returns_locked_and_never_issues_a_token()
    {
        using var db = NewContext();
        var handler = new LoginCommandHandler(
            new StubIdentity(CredentialCheckResult.LockedOut), db, new StubTokenGenerator());

        var result = await handler.Handle(new LoginCommand(Email, "whatever"), default);

        result.Outcome.Should().Be(LoginOutcome.LockedOut);
        result.Token.Should().BeNull();
    }

    [Fact]
    public async Task Invalid_credentials_returns_invalid_and_never_issues_a_token()
    {
        using var db = NewContext();
        var handler = new LoginCommandHandler(
            new StubIdentity(CredentialCheckResult.Invalid), db, new StubTokenGenerator());

        var result = await handler.Handle(new LoginCommand(Email, "wrong"), default);

        result.Outcome.Should().Be(LoginOutcome.InvalidCredentials);
        result.Token.Should().BeNull();
    }

    [Fact]
    public async Task Success_issues_a_token_and_resolves_the_member_role()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = "owner-1",
            UserId = UserId,
            Role = HouseholdRole.Admin,
            Status = MembershipStatus.Active,
            InvitedEmail = Email,
        });
        await db.SaveChangesAsync();

        var handler = new LoginCommandHandler(
            new StubIdentity(CredentialCheckResult.Success(UserId, Email, "Alex", "stamp-1")), db, new StubTokenGenerator());

        var result = await handler.Handle(new LoginCommand(Email, "correct"), default);

        result.Outcome.Should().Be(LoginOutcome.Success);
        result.Token.Should().Be($"token-for-{UserId}");
        result.ExpiresAtUtc.Should().BeAfter(DateTime.UtcNow);
        result.UserId.Should().Be(UserId);
        result.Email.Should().Be(Email);
        result.DisplayName.Should().Be("Alex");
        result.Role.Should().Be(HouseholdRole.Admin);
    }

    [Fact]
    public async Task Success_without_a_membership_defaults_to_owner()
    {
        using var db = NewContext();
        var handler = new LoginCommandHandler(
            new StubIdentity(CredentialCheckResult.Success(UserId, Email, null, "stamp-1")), db, new StubTokenGenerator());

        var result = await handler.Handle(new LoginCommand(Email, "correct"), default);

        result.Outcome.Should().Be(LoginOutcome.Success);
        result.Role.Should().Be(HouseholdRole.Owner);
    }
}
