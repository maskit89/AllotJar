using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.HouseholdAccess;
using AllotJar.Application.HouseholdAccess.Commands.AcceptInvite;
using AllotJar.Application.HouseholdAccess.Commands.ChangeMemberRole;
using AllotJar.Application.HouseholdAccess.Commands.InviteMember;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.HouseholdAccess.Commands.ResendInvite;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Application.HouseholdAccess.Queries.GetMemberships;
using AllotJar.Domain.Entities;
using AllotJar.Domain.ValueObjects;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The household access flows: inviting (direct + link), redeeming a link, and changing or
/// revoking access — including the guards that protect the Owner.
/// </summary>
public class HouseholdAccessTests
{
    private const string OwnerId = "owner-1";

    private sealed class CurrentUserStub : ICurrentUser
    {
        public CurrentUserStub(string ownerId) { OwnerId = ownerId; UserId = ownerId; }
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

    private sealed class FakeIdentity : IIdentityService
    {
        public readonly List<string> CreatedEmails = new();
        public readonly HashSet<string> ConsentedEmails = new(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> MustChangePasswordEmails = new(StringComparer.OrdinalIgnoreCase);
        public readonly HashSet<string> Existing = new(StringComparer.OrdinalIgnoreCase);
        public readonly Dictionary<string, UserAccount> ById = new();
        /// <summary>userId → the ownerId passed to SetActiveHouseholdAsync (null = own household).</summary>
        public readonly Dictionary<string, string?> ActiveHouseholds = new();

        public Task<bool> EmailExistsAsync(string email) => Task.FromResult(Existing.Contains(email));
        public Task<UserAccount?> FindByEmailAsync(string email) => Task.FromResult<UserAccount?>(null);
        public Task<UserAccount?> FindByIdAsync(string userId) =>
            Task.FromResult(ById.TryGetValue(userId, out var u) ? u : null);
        public Task<CurrencyCode?> GetPreferredCurrencyAsync(string userId) =>
            Task.FromResult<CurrencyCode?>(null); // no preference -> callers use the EUR default

        public Task<CreateUserResult> CreateUserAsync(
            string email, string password, string? displayName, bool consented = false, bool mustChangePassword = false)
        {
            CreatedEmails.Add(email);
            if (consented) ConsentedEmails.Add(email);
            if (mustChangePassword) MustChangePasswordEmails.Add(email);
            Existing.Add(email);
            var id = "user-" + Guid.NewGuid().ToString("N")[..8];
            ById[id] = new UserAccount(id, email, displayName, MustChangePassword: mustChangePassword);
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

    private static HouseholdMembership Owner() => new()
    {
        OwnerId = OwnerId,
        UserId = OwnerId,
        Role = HouseholdRole.Owner,
        Status = MembershipStatus.Active,
        InvitedEmail = "alex@x.com",
    };

    [Fact]
    public async Task Invite_direct_creates_an_active_login_membership()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        var result = await handler.Handle(new InviteMemberCommand(
            "sam@x.com", HouseholdRole.Admin, InviteMethod.Direct, "password123", "Sam", null), default);

        result.InviteToken.Should().BeNull();
        identity.CreatedEmails.Should().ContainSingle().Which.Should().Be("sam@x.com");
        // S-P2-3: the owner chose this password, so the new login must replace it first.
        identity.MustChangePasswordEmails.Should().BeEquivalentTo(new[] { "sam@x.com" });

        var membership = await db.HouseholdMemberships.SingleAsync(m => m.InvitedEmail == "sam@x.com");
        membership.Status.Should().Be(MembershipStatus.Active);
        membership.Role.Should().Be(HouseholdRole.Admin);
        membership.OwnerId.Should().Be(OwnerId);
        membership.UserId.Should().NotBeNull();
    }

    [Fact]
    public async Task Invite_link_creates_a_pending_membership_and_returns_the_token_once()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), identity);
        var result = await handler.Handle(new InviteMemberCommand(
            "sam@x.com", HouseholdRole.ReadOnly, InviteMethod.Link, null, null, null), default);

        result.InviteToken.Should().NotBeNullOrWhiteSpace();
        identity.CreatedEmails.Should().BeEmpty(); // no login until redeemed

        var membership = await db.HouseholdMemberships.SingleAsync(m => m.InvitedEmail == "sam@x.com");
        membership.Status.Should().Be(MembershipStatus.Invited);
        membership.UserId.Should().BeNull();
        membership.InviteTokenHash.Should().Be(InviteToken.Hash(result.InviteToken!));
        membership.InviteExpiresUtc.Should().BeAfter(DateTime.UtcNow);
    }

    [Fact]
    public async Task Invite_rejects_an_email_already_in_the_household()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = OwnerId, Role = HouseholdRole.Admin, Status = MembershipStatus.Invited, InvitedEmail = "sam@x.com",
        });
        await db.SaveChangesAsync();

        var handler = new InviteMemberCommandHandler(db, new CurrentUserStub(OwnerId), new FakeIdentity());
        var act = () => handler.Handle(new InviteMemberCommand(
            "sam@x.com", HouseholdRole.Admin, InviteMethod.Link, null, null, null), default);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task Accept_invite_activates_the_membership_and_creates_the_login()
    {
        using var db = NewContext();
        var token = InviteToken.Generate();
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = OwnerId,
            Role = HouseholdRole.Limited,
            Status = MembershipStatus.Invited,
            InvitedEmail = "sam@x.com",
            InviteTokenHash = InviteToken.Hash(token),
            InviteExpiresUtc = DateTime.UtcNow.AddDays(3),
        });
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var result = await handler.Handle(
            new AcceptInviteCommand(token, "password123", "Sam", AcceptedTerms: true), default);

        result.Role.Should().Be(HouseholdRole.Limited);
        result.Email.Should().Be("sam@x.com");
        result.DisplayName.Should().Be("Sam");
        // The API keys the initial verification-email dispatch off this flag — an invite-created
        // login is unverified and must get its "confirm your email" message like a registration.
        result.CreatedNewLogin.Should().BeTrue();
        identity.CreatedEmails.Should().ContainSingle();
        // The invitee accepted the terms themselves, so consent is recorded on the new login.
        identity.ConsentedEmails.Should().Contain("sam@x.com");
        // Their landing household is the one they joined, even if they start their own later.
        identity.ActiveHouseholds.Should().ContainKey(result.UserId).WhoseValue.Should().Be(OwnerId);

        var membership = await db.HouseholdMemberships.SingleAsync();
        membership.Status.Should().Be(MembershipStatus.Active);
        membership.UserId.Should().Be(result.UserId);
        membership.InviteTokenHash.Should().BeNull();
        membership.InviteExpiresUtc.Should().BeNull();
    }

    [Fact]
    public async Task Accept_invite_creating_a_new_login_requires_accepting_the_terms()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("sam@x.com");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var act = () => handler.Handle(new AcceptInviteCommand(token, "password123", "Sam"), default);

        await act.Should().ThrowAsync<ValidationException>();
        identity.CreatedEmails.Should().BeEmpty(); // rejected before any login is created
        (await db.HouseholdMemberships.SingleAsync()).Status.Should().Be(MembershipStatus.Invited);
    }

    [Fact]
    public async Task Accept_invite_rejects_an_expired_link()
    {
        using var db = NewContext();
        var token = InviteToken.Generate();
        db.HouseholdMemberships.Add(new HouseholdMembership
        {
            OwnerId = OwnerId,
            Role = HouseholdRole.Limited,
            Status = MembershipStatus.Invited,
            InvitedEmail = "sam@x.com",
            InviteTokenHash = InviteToken.Hash(token),
            InviteExpiresUtc = DateTime.UtcNow.AddDays(-1),
        });
        await db.SaveChangesAsync();

        var handler = new AcceptInviteCommandHandler(db, new FakeIdentity(), new AnonymousUserStub());
        var act = () => handler.Handle(new AcceptInviteCommand(token, "password123", null), default);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Accept_invite_rejects_an_unknown_token()
    {
        using var db = NewContext();
        var handler = new AcceptInviteCommandHandler(db, new FakeIdentity(), new AnonymousUserStub());

        var act = () => handler.Handle(new AcceptInviteCommand(InviteToken.Generate(), "password123", null), default);

        await act.Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task Change_role_updates_a_member_but_not_the_owner()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var member = new HouseholdMembership
        {
            OwnerId = OwnerId, UserId = "user-2", Role = HouseholdRole.Admin,
            Status = MembershipStatus.Active, InvitedEmail = "sam@x.com",
        };
        db.HouseholdMemberships.Add(member);
        await db.SaveChangesAsync();

        var handler = new ChangeMemberRoleCommandHandler(db, new CurrentUserStub(OwnerId));
        var dto = await handler.Handle(new ChangeMemberRoleCommand(member.Id, HouseholdRole.ReadOnly), default);
        dto.Role.Should().Be(HouseholdRole.ReadOnly);

        var ownerMembership = await db.HouseholdMemberships.SingleAsync(m => m.Role == HouseholdRole.Owner);
        var act = () => handler.Handle(new ChangeMemberRoleCommand(ownerMembership.Id, HouseholdRole.Admin), default);
        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Revoke_removes_a_member_but_never_the_owner()
    {
        using var db = NewContext();
        var owner = Owner();
        db.HouseholdMemberships.Add(owner);
        var member = new HouseholdMembership
        {
            OwnerId = OwnerId, UserId = "user-2", Role = HouseholdRole.Limited,
            Status = MembershipStatus.Active, InvitedEmail = "sam@x.com",
        };
        db.HouseholdMemberships.Add(member);
        await db.SaveChangesAsync();

        var handler = new RevokeMemberCommandHandler(db, new CurrentUserStub(OwnerId));
        await handler.Handle(new RevokeMemberCommand(member.Id), default);
        (await db.HouseholdMemberships.CountAsync()).Should().Be(1);

        var act = () => handler.Handle(new RevokeMemberCommand(owner.Id), default);
        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    private static HouseholdMembership ActiveLogin(string userId, string email, Guid? memberId = null) => new()
    {
        OwnerId = OwnerId, UserId = userId, Role = HouseholdRole.Admin,
        Status = MembershipStatus.Active, InvitedEmail = email, MemberId = memberId,
    };

    [Fact]
    public async Task Link_connects_a_login_to_a_budget_person_and_can_unlink()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var member = new HouseholdMember { OwnerId = OwnerId, Name = "Sam", DisplayOrder = 0 };
        db.HouseholdMembers.Add(member);
        var login = ActiveLogin("user-2", "sam@x.com");
        db.HouseholdMemberships.Add(login);
        await db.SaveChangesAsync();

        var handler = new LinkMembershipMemberCommandHandler(db, new CurrentUserStub(OwnerId));

        var linked = await handler.Handle(new LinkMembershipMemberCommand(login.Id, member.Id), default);
        linked.MemberId.Should().Be(member.Id);

        var unlinked = await handler.Handle(new LinkMembershipMemberCommand(login.Id, null), default);
        unlinked.MemberId.Should().BeNull();
    }

    [Fact]
    public async Task Link_rejects_a_budget_person_already_linked_to_another_login()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var member = new HouseholdMember { OwnerId = OwnerId, Name = "Sam", DisplayOrder = 0 };
        db.HouseholdMembers.Add(member);
        db.HouseholdMemberships.Add(ActiveLogin("user-2", "sam@x.com", member.Id));
        var other = ActiveLogin("user-3", "sam@x.com");
        db.HouseholdMemberships.Add(other);
        await db.SaveChangesAsync();

        var handler = new LinkMembershipMemberCommandHandler(db, new CurrentUserStub(OwnerId));
        var act = () => handler.Handle(new LinkMembershipMemberCommand(other.Id, member.Id), default);

        await act.Should().ThrowAsync<ValidationException>();
    }

    private static (HouseholdMembership membership, string token) PendingInvite(string email)
    {
        var token = InviteToken.Generate();
        var membership = new HouseholdMembership
        {
            OwnerId = OwnerId,
            Role = HouseholdRole.Admin,
            Status = MembershipStatus.Invited,
            InvitedEmail = email,
            InviteTokenHash = InviteToken.Hash(token),
            InviteExpiresUtc = DateTime.UtcNow.AddDays(3),
        };
        return (membership, token);
    }

    [Fact]
    public async Task Accept_invite_by_a_signed_in_existing_user_joins_without_a_new_login()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("sam@x.com");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.ById["user-sam"] = new UserAccount("user-sam", "sam@x.com", "Sam", EmailConfirmed: true); // already has an account

        var handler = new AcceptInviteCommandHandler(db, identity, new CurrentUserStub("user-sam"));
        var result = await handler.Handle(new AcceptInviteCommand(token, null, null), default);

        result.UserId.Should().Be("user-sam");
        result.DisplayName.Should().Be("Sam"); // the account's stored name, not the invite's
        result.CreatedNewLogin.Should().BeFalse(); // no fresh login → no initial verification email
        identity.CreatedEmails.Should().BeEmpty(); // joined with the existing login — no new one
        // Accepting lands them in the household they joined, not back in their own budget.
        identity.ActiveHouseholds.Should().ContainKey("user-sam").WhoseValue.Should().Be(OwnerId);
        var saved = await db.HouseholdMemberships.SingleAsync();
        saved.Status.Should().Be(MembershipStatus.Active);
        saved.UserId.Should().Be("user-sam");
        saved.InviteTokenHash.Should().BeNull();
    }

    [Fact]
    public async Task Accept_invite_by_a_signed_in_user_with_a_different_email_is_rejected()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("sam@x.com");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        // A DIFFERENT person is signed in — the invite is addressed to sam@x.com, not them.
        identity.ById["user-riley"] = new UserAccount("user-riley", "riley@x.com", "Riley");

        var handler = new AcceptInviteCommandHandler(db, identity, new CurrentUserStub("user-riley"));
        var act = () => handler.Handle(new AcceptInviteCommand(token, null, null), default);

        await act.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task Accept_invite_anonymously_with_an_existing_email_tells_them_to_sign_in()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("sam@x.com");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.Existing.Add("sam@x.com"); // an account exists, but the accepter isn't signed in

        var handler = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var act = () => handler.Handle(new AcceptInviteCommand(token, "password123", null), default);

        await act.Should().ThrowAsync<ValidationException>();
    }

    // ---- D3: a signed-in accept needs a confirmed email (S-P3-3) -------------------------------

    [Fact]
    public async Task Accept_invite_by_a_signed_in_user_whose_email_is_not_confirmed_is_refused_and_the_invite_waits()
    {
        using var db = NewContext();
        var (membership, token) = PendingInvite("sam@x.com");
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        // Anyone can register sam@x.com without owning it; the address alone proves nothing.
        identity.ById["user-squat"] = new UserAccount("user-squat", "sam@x.com", "Squat", EmailConfirmed: false);

        var handler = new AcceptInviteCommandHandler(db, identity, new CurrentUserStub("user-squat"));
        var act = () => handler.Handle(new AcceptInviteCommand(token, null, null), default);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors["Email"].Should().Equal(AcceptInviteCommandHandler.EmailNotConfirmed);
        var saved = await db.HouseholdMemberships.SingleAsync();
        saved.Status.Should().Be(MembershipStatus.Invited, "the invite still waits for the confirmed login");
        saved.UserId.Should().BeNull();
        identity.ActiveHouseholds.Should().BeEmpty();
    }

    // ---- D7: "Send again" ---------------------------------------------------------------------

    [Fact]
    public async Task Send_again_on_a_pending_invite_issues_a_new_link_and_the_old_one_stops_working()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var (membership, oldToken) = PendingInvite("sam@x.com");
        membership.InviteExpiresUtc = DateTime.UtcNow.AddDays(-1); // even an expired one
        db.HouseholdMemberships.Add(membership);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();

        var result = await new ResendInviteCommandHandler(db, new CurrentUserStub(OwnerId), identity)
            .Handle(new ResendInviteCommand(membership.Id), default);

        result.Email.Should().Be("sam@x.com");
        result.InviteToken.Should().NotBeNullOrEmpty().And.NotBe(oldToken);
        var saved = await db.HouseholdMemberships.SingleAsync(m => m.Id == membership.Id);
        saved.InviteTokenHash.Should().Be(InviteToken.Hash(oldToken),
            "until its email went out, the old link keeps working (review P3-2)");

        // The email went out: the new link replaces the old one.
        await new CommitResentInviteCommandHandler(db, new CurrentUserStub(OwnerId))
            .Handle(new CommitResentInviteCommand(membership.Id, result.InviteToken!), default);
        saved.InviteTokenHash.Should().Be(InviteToken.Hash(result.InviteToken!));
        saved.InviteExpiresUtc.Should().BeCloseTo(DateTime.UtcNow.AddDays(7), TimeSpan.FromMinutes(1));

        var accept = new AcceptInviteCommandHandler(db, identity, new AnonymousUserStub());
        var withOld = () => accept.Handle(new AcceptInviteCommand(oldToken, "password123", null, AcceptedTerms: true), default);
        await withOld.Should().ThrowAsync<NotFoundException>();
        var accepted = await accept.Handle(new AcceptInviteCommand(result.InviteToken!, "password123", null, AcceptedTerms: true), default);
        accepted.CreatedNewLogin.Should().BeTrue();
    }

    [Fact]
    public async Task Send_again_for_a_login_still_on_its_temporary_password_sends_its_password_link_and_nothing_once_chosen()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        var waiting = ActiveLogin("user-wait", "sam@x.com");
        var done = ActiveLogin("user-done", "riley@x.com");
        db.HouseholdMemberships.AddRange(waiting, done);
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.ById["user-wait"] = new UserAccount("user-wait", "sam@x.com", "Sam", MustChangePassword: true);
        identity.ById["user-done"] = new UserAccount("user-done", "riley@x.com", "Riley", EmailConfirmed: true);
        var handler = new ResendInviteCommandHandler(db, new CurrentUserStub(OwnerId), identity);

        var result = await handler.Handle(new ResendInviteCommand(waiting.Id), default);
        result.Should().Be(new ResendInviteResult("sam@x.com", null));

        var nothing = () => handler.Handle(new ResendInviteCommand(done.Id), default);
        (await nothing.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("MembershipId");
        var ownerMembership = await db.HouseholdMemberships.SingleAsync(m => m.UserId == OwnerId);
        var owners = () => handler.Handle(new ResendInviteCommand(ownerMembership.Id), default);
        await owners.Should().ThrowAsync<ValidationException>();
        var elsewhere = () => handler.Handle(new ResendInviteCommand(Guid.NewGuid()), default);
        await elsewhere.Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task The_owner_sees_which_logins_still_wait_to_choose_their_password()
    {
        using var db = NewContext();
        db.HouseholdMemberships.Add(Owner());
        db.HouseholdMemberships.AddRange(ActiveLogin("user-wait", "sam@x.com"), ActiveLogin("user-done", "riley@x.com"));
        await db.SaveChangesAsync();
        var identity = new FakeIdentity();
        identity.ById["user-wait"] = new UserAccount("user-wait", "sam@x.com", "Sam", MustChangePassword: true);
        identity.ById["user-done"] = new UserAccount("user-done", "riley@x.com", "Riley", EmailConfirmed: true);

        var list = await new GetMembershipsQueryHandler(db, new CurrentUserStub(OwnerId), identity)
            .Handle(new GetMembershipsQuery(), default);

        list.Single(m => m.Email == "sam@x.com").AwaitingPassword.Should().BeTrue();
        list.Single(m => m.Email == "riley@x.com").AwaitingPassword.Should().BeFalse();
        list.Single(m => m.IsOwner).AwaitingPassword.Should().BeFalse();
    }
}
