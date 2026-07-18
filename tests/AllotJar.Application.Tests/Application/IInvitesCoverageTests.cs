using FluentAssertions;
using MediatR;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;
using AllotJar.Application.HouseholdAccess.Commands.InviteMember;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Invites coverage (catalog prefix INV, file docs/testing/cases/17-invites.md).
/// Automates the highest-value P0/P1 (plus a few cheap P2/P3) cases whose behaviour lives at the
/// Application layer and was previously "No"/"Partial", without duplicating
/// <see cref="HouseholdAccessTests"/> (which already covers direct/link create, expired/unknown
/// token, terms-required, revoke/change-role owner guards, the 1:1 person↔login link, and the
/// signed-in existing-user reconcile happy path):
///
///  - INV-014 — a Direct temp-password invite to an email that already has an account is rejected.
///  - INV-013 — a Direct invite creates the login WITHOUT recording consent (ConsentModal on first sign-in).
///  - INV-015 / INV-016 — server validator: Direct temp-password &lt; 8 rejected, 8 inclusive.
///  - INV-021 — malformed email rejected by the server validator.
///  - INV-022 — email longer than 256 chars rejected (256 inclusive).
///  - INV-025 — DisplayName longer than 120 chars rejected (120 inclusive).
///  - INV-026 — Role = Owner is never grantable via invite.
///  - INV-031 — a pending invite blocks re-inviting the same budget person (memberId slot occupied).
///  - INV-032 — an invite whose memberId is not in this household → NotFound.
///  - INV-035 — the anonymous accept handler rejects a password shorter than 8 chars.
///  - INV-036 — a blank accept name falls back to the invite's DisplayName.
///  - INV-041 — a signed-in user already a member of the household cannot redeem a second invite.
///  - INV-046 — a redeemed link cannot be used a second time.
///  - INV-050 — the accepter lands with exactly the role chosen at invite time (invite→accept round-trip).
///  - INV-052 — a revoked pending link is no longer redeemable.
///  - INV-042 — SUSPECTED BUG (skipped): AuthorizationBehaviour blocks a signed-in Limited/ReadOnly accepter.
///
/// Pure client/UI cases (modal defaults, control labels, hints, copy-to-clipboard, the "Invited"
/// badge render, missing-code alert, "Not now" navigation, returnUrl round-trip) are deferred to
/// the Vitest layer (AcceptInvitePage.test.tsx / PeoplePage / returnUrl.test) and the journey
/// suite (invite.spec.ts). Rate-limiting (INV-027) and the generic-error mapping (INV-028) live at
/// the API/HTTP layer. The case-variant duplicate (INV-024) is deliberately NOT unit-tested — EF
/// InMemory compares emails case-sensitively and diverges from prod SQL, so the catalog directs it
/// to a real-backend check.
/// </summary>
public class IInvitesCoverageTests
{
    private const string OwnerId = "owner-1";

    private sealed class CurrentUserStub : ICurrentUser
    {
        public CurrentUserStub(string userId) { UserId = userId; OwnerId = userId; }
        public string? UserId { get; }
        public string? OwnerId { get; }
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId => null;
    }

    private sealed class AnonymousUserStub : ICurrentUser
    {
        public string? UserId => null;
        public string? OwnerId => null;
        public HouseholdRole? Role => null;
        public Guid? MemberId => null;
    }

    private sealed class RoleStub : ICurrentUser
    {
        public RoleStub(HouseholdRole? role) => Role = role;
        public string? UserId => "u1";
        public string? OwnerId => "u1";
        public HouseholdRole? Role { get; }
        public Guid? MemberId => null;
    }

    private sealed class FakeIdentity : IIdentityService
    {
        public readonly List<string> CreatedEmails = new();
        public readonly HashSet<string> ConsentedEmails = new(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> Existing = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, UserAccount> ById = new();
        public readonly Dictionary<string, string?> ActiveHouseholds = new();

        public Task<bool> EmailExistsAsync(string email) => Task.FromResult(Existing.Contains(email));
        public Task<UserAccount?> FindByEmailAsync(string email) => Task.FromResult<UserAccount?>(null);
        public Task<UserAccount?> FindByIdAsync(string userId) =>
            Task.FromResult(ById.TryGetValue(userId, out var u) ? u : null);

        public Task<CreateUserResult> CreateUserAsync(
            string email, string password, string? displayName, bool consented = false)
        {
            CreatedEmails.Add(email);
            if (consented) ConsentedEmails.Add(email);
            Existing.Add(email);
            var id = "user-" + Guid.NewGuid().ToString("N")[..8];
            ById[id] = new UserAccount(id, email, displayName);
            return Task.FromResult(CreateUserResult.Success(id));
        }

        public Task SetActiveHouseholdAsync(string userId, string? ownerId)
        {
            ActiveHouseholds[userId] = ownerId;
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<string>> ChangePasswordAsync(string userId, string current, string next) =>
            Task.FromResult<IReadOnlyList<string>>(Array.Empty<string>());

        public Task<CredentialCheckResult> CheckCredentialsAsync(string email, string password) =>
            Task.FromResult(CredentialCheckResult.Invalid);
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-inv-cov-{Guid.NewGuid()}")
            .Options);

    private static HouseholdMembership Owner() => new()
    {
        OwnerId = OwnerId,
        UserId = OwnerId,
        Role = HouseholdRole.Owner,
        Status = MembershipStatus.Active,
        InvitedEmail = "chris@x.com",
    };

    private static (HouseholdMembership membership, string token) PendingInvite(
        string email, HouseholdRole role = HouseholdRole.Admin, Guid? memberId = null, string? displayName = null)
    {
        var token = InviteToken.Generate();
        var membership = new HouseholdMembership
        {
            OwnerId = OwnerId,
            Role = role,
            Status = MembershipStatus.Invited,
            InvitedEmail = email,
            DisplayName = displayName,
            MemberId = memberId,
            InviteTokenHash = InviteToken.Hash(token),
            InviteExpiresUtc = DateTime.UtcNow.AddDays(3),
        };
        return (membership, token);
    }

    // ---- Direct temp-password invite ------------------------------------------------------------

    // INV-014 — a temporary password only makes sense for someone with no account yet; a Direct
    // invite to an email that already has an AllotJar account is rejected (they must use a link).
    [Fact]
    public async Task Direct_invite_to_an_email_that_already_has_an_account_is_rejected()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.Existing.Add("dana@x.eu"); // Dana already has her own account

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        var act = () => handler.Handle(new InviteMemberCommand(
            "dana@x.eu", HouseholdRole.Admin, InviteMethod.Direct, "Aa1-longpass", "Dana", null), default);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("Email");
        identity.CreatedEmails.Should().BeEmpty();                    // no second login created
        (await db.HouseholdMemberships.CountAsync()).Should().Be(1);  // no membership added
    }

    // INV-013 — the owner set the temp password on the invitee's behalf, so consent is NOT recorded
    // (ConsentedUtc stays null); the invitee agrees to the terms via the ConsentModal on first sign-in.
    [Fact]
    public async Task Direct_invite_creates_the_login_without_recording_consent()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        await handler.Handle(new InviteMemberCommand(
            "sam@x.eu", HouseholdRole.Limited, InviteMethod.Direct, "Aa1-longpass", "Sam", null), default);

        identity.CreatedEmails.Should().ContainSingle().Which.Should().Be("sam@x.eu");
        identity.ConsentedEmails.Should().NotContain("sam@x.eu");
    }

    // INV-015 / INV-016 — the server validator enforces a min-8 temp password on a Direct invite;
    // 8 is inclusive (7 fails, 8 passes).
    [Theory]
    [InlineData(7, false)]
    [InlineData(8, true)]
    public void Direct_temp_password_must_be_at_least_eight_characters(int length, bool valid)
    {
        var command = new InviteMemberCommand(
            "sam@x.eu", HouseholdRole.Limited, InviteMethod.Direct, new string('a', length), "Sam", null);

        new InviteMemberCommandValidator().Validate(command).IsValid.Should().Be(valid);
    }

    // ---- Invite validation & error paths --------------------------------------------------------

    // INV-021 — the client only checks non-empty, so a malformed address reaches the server, where
    // the .EmailAddress() validator rejects it.
    [Fact]
    public void Malformed_email_is_rejected_by_the_validator()
    {
        var result = new InviteMemberCommandValidator().Validate(new InviteMemberCommand(
            "not-an-email", HouseholdRole.Admin, InviteMethod.Link, null, "Robin", null));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == "Email");
    }

    // INV-022 — .MaximumLength(256) rejects an over-long email; a 256-char address is accepted.
    [Theory]
    [InlineData(251, true)]   // 251 local + "@x.eu" (5) = 256, the inclusive maximum
    [InlineData(252, false)]  // = 257, over the limit
    public void Email_longer_than_256_chars_is_rejected(int localLength, bool valid)
    {
        var email = new string('a', localLength) + "@x.eu";
        var command = new InviteMemberCommand(
            email, HouseholdRole.Admin, InviteMethod.Link, null, "Robin", null);

        new InviteMemberCommandValidator().Validate(command).IsValid.Should().Be(valid);
    }

    // INV-025 — .MaximumLength(120) caps the (API-crafted) displayName; 120 is inclusive.
    [Theory]
    [InlineData(120, true)]
    [InlineData(121, false)]
    public void Display_name_longer_than_120_chars_is_rejected(int length, bool valid)
    {
        var command = new InviteMemberCommand(
            "robin@x.eu", HouseholdRole.Admin, InviteMethod.Link, null, new string('n', length), null);

        new InviteMemberCommandValidator().Validate(command).IsValid.Should().Be(valid);
    }

    // INV-026 — a household has exactly one owner: Role = Owner is never grantable via an invite,
    // while Admin / Limited / Read-only all are.
    [Fact]
    public void Role_owner_is_never_grantable_via_invite()
    {
        var command = new InviteMemberCommand(
            "robin@x.eu", HouseholdRole.Owner, InviteMethod.Link, null, "Robin", null);
        var validator = new InviteMemberCommandValidator();

        var result = validator.Validate(command);
        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e =>
            e.PropertyName == "Role" && e.ErrorMessage == "A household can only have one owner.");

        validator.Validate(command with { Role = HouseholdRole.Admin }).IsValid.Should().BeTrue();
        validator.Validate(command with { Role = HouseholdRole.Limited }).IsValid.Should().BeTrue();
        validator.Validate(command with { Role = HouseholdRole.ReadOnly }).IsValid.Should().BeTrue();
    }

    // ---- Linking the invite to a budget person (1:1) --------------------------------------------

    // INV-031 — a pending invite occupies the person's memberId slot, so inviting a DIFFERENT email
    // but the same memberId is rejected until the pending row is removed (the person↔login link is 1:1).
    [Fact]
    public async Task A_pending_invite_blocks_re_inviting_the_same_person_via_member_id()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var robin = new HouseholdMember { OwnerId = OwnerId, Name = "Robin", DisplayOrder = 0 };
        db.HouseholdMembers.Add(robin);
        var (pending, _) = PendingInvite("robin@x.eu", HouseholdRole.Admin, robin.Id);
        db.HouseholdMemberships.Add(pending);
        await db.SaveChangesAsync();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), new FakeIdentity());
        var act = () => handler.Handle(new InviteMemberCommand(
            "different@x.eu", HouseholdRole.Limited, InviteMethod.Link, null, "Robin", robin.Id), default);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("MemberId");
        // Only the owner + the pending invite exist; no third membership was added.
        (await db.HouseholdMemberships.CountAsync()).Should().Be(2);
    }

    // INV-032 — an invite whose memberId belongs to no person in this household is a 404
    // (a cross-household link is never possible; the UI never produces this).
    [Fact]
    public async Task Invite_with_a_member_id_not_in_this_household_is_not_found()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), new FakeIdentity());
        var act = () => handler.Handle(new InviteMemberCommand(
            "robin@x.eu", HouseholdRole.Admin, InviteMethod.Link, null, "Robin", Guid.NewGuid()), default);

        await act.Should().ThrowAsync<NotFoundException>();
    }

    // ---- Accept — brand-new user (anonymous) ----------------------------------------------------

    // INV-035 — the accept handler is the real guard for the empty/short-password case: an anonymous
    // accept with a password under 8 chars is rejected before any login is created.
    [Fact]
    public async Task Anonymous_accept_with_a_short_password_is_rejected()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("robin@x.eu", HouseholdRole.Limited);
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var act = () => handler.Handle(
            new AcceptInviteCommand(token, "Aa1-x", DisplayName: null, AcceptedTerms: true), default);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("Password");
        identity.CreatedEmails.Should().BeEmpty();
        (await db.HouseholdMemberships.SingleAsync()).Status.Should().Be(MembershipStatus.Invited);
    }

    // INV-036 — the accept name is optional: with none typed, the created login and the activated
    // membership fall back to the invite's own DisplayName.
    [Fact]
    public async Task Anonymous_accept_with_no_name_falls_back_to_the_invite_display_name()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("robin@x.eu", HouseholdRole.Limited, displayName: "Robin");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var result = await handler.Handle(
            new AcceptInviteCommand(token, "Aa1-longpass", DisplayName: null, AcceptedTerms: true), default);

        result.DisplayName.Should().Be("Robin");
        identity.ById[result.UserId].DisplayName.Should().Be("Robin");
        (await db.HouseholdMemberships.SingleAsync()).DisplayName.Should().Be("Robin");
    }

    // ---- Accept — signed-in existing user -------------------------------------------------------

    // INV-041 — a signed-in user who is already an active member of the household cannot redeem a
    // second pending invite to it; the duplicate invite lingers unredeemed.
    [Fact]
    public async Task Signed_in_accept_when_already_a_member_is_rejected()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = OwnerId, UserId = "user-liza", Role = HouseholdRole.Admin,
            Status = MembershipStatus.Active, InvitedEmail = "liza@x.eu",
        });
        var (pending, token) = PendingInvite("liza@x.eu");
        db.HouseholdMemberships.Add(pending);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.ById["user-liza"] = new UserAccount("user-liza", "liza@x.eu", "Liza");

        var handler = new AcceptInviteCommandHandler(db, identity, new CurrentUserStub("user-liza"));
        var act = () => handler.Handle(new AcceptInviteCommand(token, null, null), default);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Should().ContainKey("Email");
        (await db.HouseholdMemberships.CountAsync(m => m.Status == MembershipStatus.Invited)).Should().Be(1);
    }

    // ---- Accept — reused / revoked links --------------------------------------------------------

    // INV-046 — a link truly works once: after redemption the membership is Active and its token
    // hash is cleared, so the same token no longer resolves (the reuse case shares the not-found path).
    [Fact]
    public async Task A_redeemed_link_cannot_be_used_a_second_time()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("robin@x.eu", HouseholdRole.Limited, displayName: "Robin");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        await handler.Handle(new AcceptInviteCommand(token, "Aa1-longpass", "Robin", AcceptedTerms: true), default);

        var again = () => handler.Handle(
            new AcceptInviteCommand(token, "Aa1-longpass", "Robin", AcceptedTerms: true), default);
        await again.Should().ThrowAsync<NotFoundException>();
        identity.CreatedEmails.Should().ContainSingle(); // only the first accept created a login
    }

    // INV-052 — revoking a pending invite hard-deletes the membership, so its link immediately and
    // permanently stops resolving (the invitee must be re-invited with a fresh token).
    [Fact]
    public async Task A_revoked_pending_link_is_no_longer_redeemable()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var invite = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        var invited = await invite.Handle(new InviteMemberCommand(
            "robin@x.eu", HouseholdRole.Admin, InviteMethod.Link, null, "Robin", null), default);

        var revoke = new RevokeMemberCommandHandler(db, new CurrentUserStub(OwnerId));
        await revoke.Handle(new RevokeMemberCommand(invited.Membership.Id), default);

        var accept = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var act = () => accept.Handle(new AcceptInviteCommand(
            invited.InviteToken!, "Aa1-longpass", "Robin", AcceptedTerms: true), default);

        await act.Should().ThrowAsync<NotFoundException>();
        (await db.HouseholdMemberships.CountAsync()).Should().Be(1); // only the owner row remains
    }

    // ---- Role assigned via invite ---------------------------------------------------------------

    // INV-050 — the role chosen at invite time is exactly the role the accepter lands with, verified
    // end to end through the real invite and accept handlers (invite persists Role, accept preserves it).
    [Fact]
    public async Task Accepter_lands_with_exactly_the_role_chosen_at_invite_time()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var invite = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        var invited = await invite.Handle(new InviteMemberCommand(
            "robin@x.eu", HouseholdRole.Limited, InviteMethod.Link, null, "Robin", null), default);
        invited.InviteToken.Should().NotBeNullOrWhiteSpace();

        var accept = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var result = await accept.Handle(new AcceptInviteCommand(
            invited.InviteToken!, "Aa1-longpass", "Robin", AcceptedTerms: true), default);

        result.Role.Should().Be(HouseholdRole.Limited);
        var saved = await db.HouseholdMemberships.SingleAsync(m => m.InvitedEmail == "robin@x.eu");
        saved.Role.Should().Be(HouseholdRole.Limited);
        saved.Status.Should().Be(MembershipStatus.Active);
    }

    // ---- Suspected defect -----------------------------------------------------------------------

    // INV-042 — FIXED. AcceptInviteCommand now carries [AllowAnyRole], so AuthorizationBehaviour
    // skips the role gate: a signed-in Limited/Read-only login (role resolved from their CURRENT
    // household) reaches the handler and can accept an invite to a DIFFERENT household. Accepting an
    // invite is authorized by the invite token, not by the accepter's role in an unrelated household.
    [Fact]
    public async Task Signed_in_limited_user_can_accept_an_invite_through_the_pipeline()
    {
        var behaviour = new AuthorizationBehaviour<AcceptInviteCommand, AcceptInviteResult>(
            new RoleStub(HouseholdRole.Limited));
        var ran = false;
        RequestHandlerDelegate<AcceptInviteResult> next = _ =>
        {
            ran = true;
            return Task.FromResult(new AcceptInviteResult("user-1", "robin@x.eu", HouseholdRole.Limited, "Robin"));
        };

        await behaviour.Handle(
            new AcceptInviteCommand("token", "Aa1-longpass", "Robin", AcceptedTerms: true),
            next, CancellationToken.None);

        ran.Should().BeTrue();
    }

    // INV-042 (sibling) — a Read-only login is the harder case: HouseholdRole.ReadOnly => false in
    // IsPermitted for EVERY command, so [AllowLimited] alone would not have helped. [AllowAnyRole]
    // exempts the command outright, so a signed-in Read-only user can accept an invite too.
    [Fact]
    public async Task Signed_in_readonly_user_can_accept_an_invite_through_the_pipeline()
    {
        var behaviour = new AuthorizationBehaviour<AcceptInviteCommand, AcceptInviteResult>(
            new RoleStub(HouseholdRole.ReadOnly));
        var ran = false;
        RequestHandlerDelegate<AcceptInviteResult> next = _ =>
        {
            ran = true;
            return Task.FromResult(new AcceptInviteResult("user-1", "robin@x.eu", HouseholdRole.ReadOnly, "Robin"));
        };

        await behaviour.Handle(
            new AcceptInviteCommand("token", "Aa1-longpass", "Robin", AcceptedTerms: true),
            next, CancellationToken.None);

        ran.Should().BeTrue();
    }
}
