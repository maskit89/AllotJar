using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.SetAccountSharing;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Application.HouseholdAccess.Commands.LinkMembershipMember;
using AllotJar.Application.HouseholdAccess.Commands.ReleasePersonLogin;
using AllotJar.Application.HouseholdAccess.Commands.RevokeMember;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// S-P3-8, D5 ("only the person's own login may make their account private"), PR #307 review
/// round 1 P2-1: every login ever linked to a person is remembered, and privacy is refused while
/// any other one that hasn't released its link is still in the household. Only that login can
/// release it ("This isn't me"); one that leaves or is removed stops counting.
/// Household: Chris (owner login, person Chris), Sam (login, not linked yet) and person Sam.
/// </summary>
public class PersonLoginsTests
{
    private const string Household = "chris-login";
    private const string SamLogin = "sam-login";

    private sealed class Viewer(string userId, Guid? memberId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => Household;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId { get; } = memberId;
    }

    private readonly DbContextOptions<ApplicationDbContext> _options = new DbContextOptionsBuilder<ApplicationDbContext>()
        .UseInMemoryDatabase($"person-logins-{Guid.NewGuid()}").Options;
    private readonly Guid _chris;
    private readonly Guid _sam;
    private readonly Guid _own;
    private readonly Guid _samMembership;

    public PersonLoginsTests()
    {
        using var db = new ApplicationDbContext(_options);
        var chris = new HouseholdMember { OwnerId = Household, Name = "Chris", DisplayOrder = 0 };
        var sam = new HouseholdMember { OwnerId = Household, Name = "Sam", DisplayOrder = 1 };
        db.HouseholdMembers.AddRange(chris, sam);
        db.SaveChanges();
        _chris = chris.Id;
        _sam = sam.Id;
        // The owner's link predates the record (seeded before PersonLogins existed): it counts lazily.
        var own = new HouseholdMembership { OwnerId = Household, UserId = Household, Role = HouseholdRole.Owner, MemberId = _chris, InvitedEmail = "chris@example.com", Status = MembershipStatus.Active };
        var samM = new HouseholdMembership { OwnerId = Household, UserId = SamLogin, Role = HouseholdRole.Admin, MemberId = null, InvitedEmail = "sam@example.com", Status = MembershipStatus.Active };
        db.HouseholdMemberships.AddRange(own, samM);
        db.SaveChanges();
        _own = own.Id;
        _samMembership = samM.Id;
    }

    private ApplicationDbContext As(ICurrentUser v) => new(_options, v);
    private Viewer Chris => new(Household, _chris);
    private Viewer ChrisAsSam => new(Household, _sam);
    private Viewer Sam => new(SamLogin, _sam);

    private async Task LinkAsync(Guid membership, Guid? person)
    {
        await using var db = As(Chris);
        await new LinkMembershipMemberCommandHandler(db, Chris)
            .Handle(new LinkMembershipMemberCommand(membership, person), CancellationToken.None);
    }

    private async Task<Guid> SamsSharedAccountAsync()
    {
        await using var db = As(Sam);
        var dto = await new CreateAccountCommandHandler(db, Sam).Handle(
            new CreateAccountCommand("Sam's current", AccountType.Current, "EUR", 500m, LedgerFixtures.DefaultOpening,
                HolderIds: new[] { _sam }, IsPrivate: false), CancellationToken.None);
        return dto.Id;
    }

    private Func<Task> MakePrivate(ICurrentUser viewer, Guid account) => async () =>
    {
        await using var db = As(viewer);
        await new SetAccountSharingCommandHandler(db, viewer)
            .Handle(new SetAccountSharingCommand(account, true), CancellationToken.None);
    };

    private async Task ReleaseAsync(ICurrentUser viewer, Guid person)
    {
        await using var db = As(viewer);
        await new ReleasePersonLoginCommandHandler(db, viewer)
            .Handle(new ReleasePersonLoginCommand(person), CancellationToken.None);
    }

    private async Task<bool> CanReleaseAsync(ICurrentUser viewer, Guid person)
    {
        await using var db = As(viewer);
        var members = await new GetHouseholdMembersQueryHandler(db, viewer)
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        return members.Single(m => m.Id == person).CanReleaseMyLink;
    }

    private async Task<bool> SamSeesAsync(Guid account)
    {
        await using var db = As(Sam);
        return await db.Accounts.AnyAsync(a => a.Id == account);
    }

    /// <summary>
    /// Regression for the review probe Gap_OwnerOnceLinkedToSam_BlocksSam_AndThenHidesSamsAccount:
    /// the owner's login was linked to Sam once, then Sam's login. The owner unlinks Sam, links itself
    /// to Sam again and tries to make Sam's account private: refused, because Sam's login is on record
    /// too and still in the household. Nor can the owner release Sam's link.
    /// </summary>
    [Fact]
    public async Task OwnerOnceLinkedToSam_CanNeverHideSamsAccount_ByUnlinkingSamAndLinkingItself()
    {
        await LinkAsync(_own, _sam);
        await LinkAsync(_own, _chris);
        await LinkAsync(_samMembership, _sam);
        var shared = await SamsSharedAccountAsync();

        // The owner's earlier link still counts, so Sam waits for it to be released (below).
        (await MakePrivate(Sam, shared).Should().ThrowAsync<ValidationException>())
            .Which.Errors["IsPrivate"].Should().ContainSingle(e => e.Contains("Only Sam's own login"));

        await LinkAsync(_samMembership, null);
        await LinkAsync(_own, _sam);
        (await MakePrivate(ChrisAsSam, shared).Should().ThrowAsync<ValidationException>())
            .Which.Errors["IsPrivate"].Should().ContainSingle(e => e.Contains("Only Sam's own login"));

        // "This isn't me" only ever releases the caller's own link: while linked it is refused, and
        // once unlinked it releases the owner's row, never Sam's.
        var whileLinked = () => ReleaseAsync(ChrisAsSam, _sam);
        await whileLinked.Should().ThrowAsync<ValidationException>();
        await LinkAsync(_own, _chris);
        await ReleaseAsync(Chris, _sam);
        await LinkAsync(_own, _sam);
        await MakePrivate(ChrisAsSam, shared).Should().ThrowAsync<ValidationException>(
            "Sam's own link is still on record and Sam's login is still in the household");
        (await SamSeesAsync(shared)).Should().BeTrue();

        await using var check = As(Chris);
        (await check.PersonLogins.SingleAsync(p => p.HouseholdMemberId == _sam && p.UserId == SamLogin))
            .ReleasedUtc.Should().BeNull("nobody but Sam's login can release Sam's link");
    }

    [Fact]
    public async Task TheWronglyLinkedLogin_ReleasesItself_ThenSamsOwnLoginMayMakeItPrivate()
    {
        await LinkAsync(_own, _sam);
        await LinkAsync(_own, _chris);
        await LinkAsync(_samMembership, _sam);
        var shared = await SamsSharedAccountAsync();
        await MakePrivate(Sam, shared).Should().ThrowAsync<ValidationException>();

        (await CanReleaseAsync(Chris, _sam)).Should().BeTrue("the owner's login sees 'This isn't me' on Sam");
        (await CanReleaseAsync(Sam, _sam)).Should().BeFalse("Sam's login is linked to Sam now");
        (await CanReleaseAsync(Chris, _chris)).Should().BeFalse("the owner's login is linked to Chris now");

        await ReleaseAsync(Chris, _sam);
        (await CanReleaseAsync(Chris, _sam)).Should().BeFalse();
        var again = () => ReleaseAsync(Chris, _sam);
        await again.Should().ThrowAsync<NotFoundException>("there is nothing left to release");
        var neverLinked = () => ReleaseAsync(Sam, _chris);
        await neverLinked.Should().ThrowAsync<NotFoundException>();

        await MakePrivate(Sam, shared).Should().NotThrowAsync();
        (await SamSeesAsync(shared)).Should().BeTrue();

        // Linking the owner's login to Sam again puts its link back on record.
        await LinkAsync(_samMembership, null);
        await LinkAsync(_own, _sam);
        await using var check = As(Chris);
        (await check.PersonLogins.SingleAsync(p => p.HouseholdMemberId == _sam && p.UserId == Household))
            .ReleasedUtc.Should().BeNull();
    }

    [Fact]
    public async Task ALoginThatLeavesOrIsRemoved_NoLongerBlocks()
    {
        await LinkAsync(_samMembership, _sam);
        var shared = await SamsSharedAccountAsync();
        await LinkAsync(_samMembership, null);
        await LinkAsync(_own, _sam);
        await MakePrivate(ChrisAsSam, shared).Should().ThrowAsync<ValidationException>();

        await using (var db = As(Chris))
        {
            await new RevokeMemberCommandHandler(db, Chris)
                .Handle(new RevokeMemberCommand(_samMembership), CancellationToken.None);
        }
        await MakePrivate(ChrisAsSam, shared).Should().NotThrowAsync(
            "Sam's login is no longer in the household (P59 keeps such privacy reversible by its login)");
    }

    [Fact]
    public async Task ACurrentLinkMadeBeforeTheRecord_IsWrittenDownWhenItChanges()
    {
        await using (var db = As(Chris))
        {
            (await db.PersonLogins.AnyAsync()).Should().BeFalse("nothing recorded the seeded owner link yet");
        }
        await LinkAsync(_own, _sam);
        await using (var db = As(Chris))
        {
            (await db.PersonLogins.Select(p => new { p.HouseholdMemberId, p.UserId }).ToListAsync())
                .Should().BeEquivalentTo(new[] { new { HouseholdMemberId = _chris, UserId = Household }, new { HouseholdMemberId = _sam, UserId = Household } });
        }
    }
}
