using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.SetAccountSharing;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Queries.GetAllocationProfile;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// S-P2-1 and S-P2-2 (end-to-end check, 30 Sep 2026): P56 says "the others never receive a private
/// account's id" and P53 that the account is not there for them. The People list and the
/// allocation profile used to hand every login the id of a savings account or allocation source
/// private to someone else. They now say "private" without the id, and a save from a login that
/// can't see the account leaves it in place.
/// </summary>
public class PrivateAccountIdsTests
{
    private const string Household = "chris-login";
    private const string SamLogin = "sam-login";
    private static readonly DateOnly Opening = new(2026, 1, 1);

    private sealed class Viewer(string userId, Guid? memberId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId => Household;
        public HouseholdRole? Role => HouseholdRole.Owner;
        public Guid? MemberId { get; } = memberId;
    }

    private readonly DbContextOptions<ApplicationDbContext> _options = new DbContextOptionsBuilder<ApplicationDbContext>()
        .UseInMemoryDatabase($"private-ids-{Guid.NewGuid()}")
        .Options;

    private readonly Guid _chris;
    private readonly Guid _sam;

    public PrivateAccountIdsTests()
    {
        using var db = new ApplicationDbContext(_options);
        _chris = AddPerson(db, "Chris", 0);
        _sam = AddPerson(db, "Sam", 1);
        db.HouseholdMemberships.AddRange(
            new HouseholdMembership { OwnerId = Household, UserId = Household, Role = HouseholdRole.Owner, MemberId = _chris, InvitedEmail = "chris@example.com" },
            new HouseholdMembership { OwnerId = Household, UserId = SamLogin, Role = HouseholdRole.Admin, MemberId = _sam, InvitedEmail = "sam@example.com" });
        db.SaveChanges();
    }

    private Viewer Chris => new(Household, _chris);
    private Viewer Sam => new(SamLogin, _sam);
    private ApplicationDbContext As(ICurrentUser viewer) => new(_options, viewer);

    private static Guid AddPerson(ApplicationDbContext db, string name, int order)
    {
        var member = new HouseholdMember { OwnerId = Household, Name = name, DisplayOrder = order };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member.Id;
    }

    private async Task<Guid> CreateAccountAsync(Viewer viewer, string name, IReadOnlyList<Guid>? holders, bool? isPrivate = null)
    {
        await using var db = As(viewer);
        var dto = await new CreateAccountCommandHandler(db, viewer).Handle(
            new CreateAccountCommand(name, AccountType.Current, "EUR", 1000m, Opening, HolderIds: holders, IsPrivate: isPrivate),
            CancellationToken.None);
        return dto.Id;
    }

    /// <summary>Sam's personal account starts private (P54) and Sam picks it as his savings account.</summary>
    private async Task<Guid> SamsPrivateSavingsAsync()
    {
        var samSavings = await CreateAccountAsync(Sam, "Sam's savings", new[] { _sam });
        await using var db = As(Sam);
        await new UpdateHouseholdMemberCommandHandler(db, Sam).Handle(
            new UpdateHouseholdMemberCommand(_sam, "Sam", 2000m, samSavings), CancellationToken.None);
        return samSavings;
    }

    private async Task<HouseholdMemberDto> SamAsSeenByAsync(Viewer viewer)
    {
        await using var db = As(viewer);
        var people = await new GetHouseholdMembersQueryHandler(db, viewer)
            .Handle(new GetHouseholdMembersQuery(false, 2026, 6), CancellationToken.None);
        return people.Single(p => p.Id == _sam);
    }

    [Fact]
    public async Task The_people_list_says_private_without_the_id_of_another_logins_savings_account()
    {
        var samSavings = await SamsPrivateSavingsAsync();

        var seenByChris = await SamAsSeenByAsync(Chris);
        seenByChris.PersonalSavingsAccountId.Should().BeNull("P56: the others never receive a private account's id");
        seenByChris.SavingsPrivate.Should().BeTrue("Chris is told Sam has a savings account, just not which");

        var seenBySam = await SamAsSeenByAsync(Sam);
        seenBySam.PersonalSavingsAccountId.Should().Be(samSavings, "the account's own login sees its choice");
        seenBySam.SavingsPrivate.Should().BeFalse();
    }

    [Fact]
    public async Task A_shared_savings_account_keeps_its_id_for_everyone()
    {
        var shared = await CreateAccountAsync(Sam, "Sam's shared savings", new[] { _sam }, isPrivate: false);
        await using (var db = As(Sam))
        {
            await new UpdateHouseholdMemberCommandHandler(db, Sam).Handle(
                new UpdateHouseholdMemberCommand(_sam, "Sam", 2000m, shared), CancellationToken.None);
        }

        var seenByChris = await SamAsSeenByAsync(Chris);
        seenByChris.PersonalSavingsAccountId.Should().Be(shared);
        seenByChris.SavingsPrivate.Should().BeFalse();
    }

    [Fact]
    public async Task Saving_the_person_from_a_login_that_cannot_see_the_account_keeps_it_and_answers_without_its_id()
    {
        var samSavings = await SamsPrivateSavingsAsync();

        // Chris edits Sam's income from the People page, which had no id to send back.
        await using (var db = As(Chris))
        {
            var saved = await new UpdateHouseholdMemberCommandHandler(db, Chris).Handle(
                new UpdateHouseholdMemberCommand(_sam, "Sam", 2500m, null), CancellationToken.None);
            saved.PersonalSavingsAccountId.Should().BeNull("the save's answer withholds the id too");
            saved.SavingsPrivate.Should().BeTrue();
        }

        await using (var db = As(Sam))
        {
            var sam = await db.HouseholdMembers.SingleAsync(m => m.Id == _sam);
            sam.PersonalSavingsAccountId.Should().Be(samSavings, "P53: someone who can't see it must not lose it");
            sam.NetMonthlyIncome.Should().Be(2500m);
        }
    }

    [Fact]
    public async Task The_accounts_own_login_can_still_clear_it()
    {
        await SamsPrivateSavingsAsync();

        await using (var db = As(Sam))
        {
            await new UpdateHouseholdMemberCommandHandler(db, Sam).Handle(
                new UpdateHouseholdMemberCommand(_sam, "Sam", 2000m, null), CancellationToken.None);
        }

        var seenBySam = await SamAsSeenByAsync(Sam);
        seenBySam.PersonalSavingsAccountId.Should().BeNull();
        seenBySam.SavingsPrivate.Should().BeFalse();
    }

    [Fact]
    public async Task Another_login_can_still_replace_it_with_an_account_it_can_see()
    {
        await SamsPrivateSavingsAsync();
        var joint = await CreateAccountAsync(Chris, "Joint savings", holders: null);

        await using (var db = As(Chris))
        {
            await new UpdateHouseholdMemberCommandHandler(db, Chris).Handle(
                new UpdateHouseholdMemberCommand(_sam, "Sam", 2000m, joint), CancellationToken.None);
        }

        var seenByChris = await SamAsSeenByAsync(Chris);
        seenByChris.PersonalSavingsAccountId.Should().Be(joint);
        seenByChris.SavingsPrivate.Should().BeFalse();
    }

    /// <summary>Chris picks Sam's then-shared account as the allocation source; Sam then makes it private.</summary>
    private async Task<(Guid ProfileId, Guid Source)> ProfileWithASourceSamMadePrivateAsync()
    {
        var samCurrent = await CreateAccountAsync(Sam, "Sam's current", new[] { _sam }, isPrivate: false);
        AllocationProfileDto profile;
        await using (var db = As(Chris))
        {
            profile = await new UpsertAllocationProfileCommandHandler(db, Chris).Handle(
                new UpsertAllocationProfileCommand(null, "Monthly", samCurrent, new List<AllocationRuleSpec>
                {
                    new(0, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
                }), CancellationToken.None);
        }
        await using (var db = As(Sam))
        {
            await new SetAccountSharingCommandHandler(db, Sam).Handle(new SetAccountSharingCommand(samCurrent, true), CancellationToken.None);
        }
        return (profile.Id, samCurrent);
    }

    private async Task<AllocationProfileDto> ProfileAsSeenByAsync(Viewer viewer)
    {
        await using var db = As(viewer);
        var profile = await new GetAllocationProfileQueryHandler(db, viewer).Handle(new GetAllocationProfileQuery(), CancellationToken.None);
        profile.Should().NotBeNull();
        return profile!;
    }

    [Fact]
    public async Task The_allocation_profile_says_private_without_the_id_of_a_source_made_private()
    {
        var (_, source) = await ProfileWithASourceSamMadePrivateAsync();

        var seenByChris = await ProfileAsSeenByAsync(Chris);
        seenByChris.SourceAccountId.Should().BeNull("P53: the source is private to Sam");
        seenByChris.SourcePrivate.Should().BeTrue();

        var seenBySam = await ProfileAsSeenByAsync(Sam);
        seenBySam.SourceAccountId.Should().Be(source);
        seenBySam.SourcePrivate.Should().BeFalse();
    }

    [Fact]
    public async Task Saving_the_profile_from_a_login_that_cannot_see_the_source_keeps_it()
    {
        var (profileId, source) = await ProfileWithASourceSamMadePrivateAsync();

        await using (var db = As(Chris))
        {
            var saved = await new UpsertAllocationProfileCommandHandler(db, Chris).Handle(
                new UpsertAllocationProfileCommand(profileId, "Monthly", null, new List<AllocationRuleSpec>
                {
                    new(0, AllocationRuleType.SplitRemainderToMembers, SplitMethod.BalanceTilt, 0m),
                }, BalanceLeanPercent: 40), CancellationToken.None);
            saved.SourceAccountId.Should().BeNull("the save's answer withholds the id too");
            saved.SourcePrivate.Should().BeTrue();
            saved.BalanceLeanPercent.Should().Be(40, "the rest of the change still lands");
        }

        await using (var db = As(Sam))
        {
            (await db.AllocationProfiles.SingleAsync(p => p.Id == profileId)).SourceAccountId.Should().Be(source);
        }
    }

    [Fact]
    public async Task Another_login_can_still_choose_a_source_it_can_see()
    {
        var (profileId, _) = await ProfileWithASourceSamMadePrivateAsync();
        var joint = await CreateAccountAsync(Chris, "Joint", holders: null);

        await using (var db = As(Chris))
        {
            await new UpsertAllocationProfileCommandHandler(db, Chris).Handle(
                new UpsertAllocationProfileCommand(profileId, "Monthly", joint, new List<AllocationRuleSpec>()), CancellationToken.None);
        }

        var seenByChris = await ProfileAsSeenByAsync(Chris);
        seenByChris.SourceAccountId.Should().Be(joint);
        seenByChris.SourcePrivate.Should().BeFalse();
    }
}
