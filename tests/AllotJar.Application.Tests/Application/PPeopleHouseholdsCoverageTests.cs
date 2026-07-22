using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.CreateHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Gap-fill coverage for the PEOPLE &amp; HOUSEHOLDS catalog
/// (docs/testing/cases/16-people-households.md) at the Application/domain layer:
/// the "nothing was deleted" invariant when a member with income and attributed
/// transactions is archived (PPL-023); cross-household data isolation / owner-scoping
/// (PPL-058); the untested archive-toggle <c>{archived:false}</c> restore leg that
/// re-includes the member and recomputes the income-share pool (PPL-077); the all-zero
/// income divide-by-zero guard (PPL-073); the documented mapping quirk where an archived
/// earner fetched with <c>includeArchived=true</c> keeps a non-zero share (PPL-025); and
/// the guard-before-write on a foreign/bogus personal savings account for both create and
/// update (PPL-075 / PPL-076). Conventions mirror HouseholdMembersTests / MemberSpendingTests
/// (EF InMemory context, CurrentUserStub whose OwnerId defaults to UserId, FluentAssertions 7).
/// </summary>
public class PPeopleHouseholdsCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-pplcov-{Guid.NewGuid()}")
            .Options);

    private static async Task<HouseholdMember> SeedMember(
        ApplicationDbContext db, string ownerId, string name, decimal net,
        bool archived = false, int order = 0)
    {
        var m = new HouseholdMember
        {
            OwnerId = ownerId,
            Name = name,
            NetMonthlyIncome = net,
            IsArchived = archived,
            DisplayOrder = order,
        };
        db.HouseholdMembers.Add(m);
        await db.SaveChangesAsync();
        return m;
    }

    private static async Task<Account> SeedAccount(ApplicationDbContext db, string ownerId, string name)
    {
        var a = new Account { OwnerId = ownerId, Name = name, Currency = CurrencyCode.Eur, DisplayOrder = 0 };
        db.Accounts.Add(a);
        await db.SaveChangesAsync();
        return a;
    }

    private static async Task SeedExpense(
        ApplicationDbContext db, string ownerId, Guid memberId, decimal amount, DateOnly date)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId,
            Date = date,
            Payee = "Shop",
            Amount = amount,
            Type = TransactionType.Expense,
            MemberId = memberId,
        });
        await db.SaveChangesAsync();
    }

    // ---- PPL-023: archive a member with income AND attributed transactions ------------

    [Fact]
    public async Task Archive_KeepsHerAttributedTransactions_AndDropsHerFromSpendingAndShares()
    {
        // PPL-023 (P0) — archiving is soft: leave/revoke/archive keep the budget person's
        // attributed data ("Nothing was deleted"). After archiving Sam she leaves the default
        // member list, the spending lens and the income-share pool, but her HouseholdMember row
        // and every transaction attributed to her stay exactly where they were. Existing tests
        // cover archive-hides-from-default and spending-excludes-archived, but never assert the
        // transactions survive the archive.
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, order: 1);
        await SeedExpense(db, "user-1", sam.Id, 200m, new DateOnly(2026, 6, 1));
        await SeedExpense(db, "user-1", sam.Id, 300m, new DateOnly(2026, 6, 2));

        await new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveHouseholdMemberCommand(sam.Id), CancellationToken.None);

        // Nothing was deleted: her HouseholdMember row persists (soft-archived) and both of her
        // €500 of attributed transactions remain in the register still tagged to her.
        var savedLiza = await db.HouseholdMembers.SingleAsync(m => m.Id == sam.Id);
        savedLiza.IsArchived.Should().BeTrue();
        var lizaTx = await db.Transactions.Where(t => t.MemberId == sam.Id).ToListAsync();
        lizaTx.Should().HaveCount(2);
        lizaTx.Sum(t => t.Amount).Should().Be(500m);

        // Default member list now excludes her; Alex carries the whole active pool (share 100%).
        var members = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        members.Should().ContainSingle().Which.Name.Should().Be("Alex");
        members.Single().IncomeSharePct.Should().Be(1m); // 3000 / 3000 — Sam's 1000 no longer in the pool

        // Spending lens drops her €500 too (she is out of the active member set).
        var spending = await new GetMemberSpendingQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetMemberSpendingQuery(), CancellationToken.None);
        spending.Should().ContainSingle().Which.Name.Should().Be("Alex");
        spending.Single().Spent.Should().Be(0m);
    }

    // ---- PPL-058: data isolation — everything is scoped to the active household -------

    [Fact]
    public async Task DataIsolation_MembersAccountsAndSpendingAreScopedToTheActiveHousehold()
    {
        // PPL-058 (P0) — OwnerId is the household partition key; members, accounts and
        // transaction-derived spending are all filtered by the active household. A login active
        // in "own" must never see household B's member, account, or attributed spend, and vice
        // versa. Owner-scoping is asserted piecemeal elsewhere; this pins the whole cross-household
        // partition at once.
        await using var db = NewContext();
        // "own" household: a single member and one account, no transactions.
        var chrisOwn = await SeedMember(db, "own", "Alex", 500m);
        await SeedAccount(db, "own", "Solo");
        // Household B: two members, an account, and €200 of spend attributed to Sam.
        var chrisB = await SeedMember(db, "houseB", "Alex", 3000m, order: 0);
        var lizaB = await SeedMember(db, "houseB", "Sam", 1000m, order: 1);
        await SeedAccount(db, "houseB", "Joint");
        await SeedExpense(db, "houseB", lizaB.Id, 200m, new DateOnly(2026, 6, 1));

        // As "own": only own data is visible.
        var ownMembers = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("own"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        ownMembers.Should().ContainSingle().Which.Id.Should().Be(chrisOwn.Id);

        var ownAccounts = await new GetAccountsQueryHandler(db, new CurrentUserStub("own"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);
        ownAccounts.Should().ContainSingle().Which.Name.Should().Be("Solo");

        var ownSpending = await new GetMemberSpendingQueryHandler(db, new CurrentUserStub("own"))
            .Handle(new GetMemberSpendingQuery(), CancellationToken.None);
        ownSpending.Should().ContainSingle().Which.Spent.Should().Be(0m); // household B's €200 does not leak in

        // As "houseB": only B's data is visible, and B's spend is intact.
        var bMembers = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("houseB"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        bMembers.Select(m => m.Id).Should().BeEquivalentTo(new[] { chrisB.Id, lizaB.Id });

        var bAccounts = await new GetAccountsQueryHandler(db, new CurrentUserStub("houseB"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);
        bAccounts.Should().ContainSingle().Which.Name.Should().Be("Joint");

        var bSpending = await new GetMemberSpendingQueryHandler(db, new CurrentUserStub("houseB"))
            .Handle(new GetMemberSpendingQuery(), CancellationToken.None);
        bSpending.Single(m => m.Name == "Sam").Spent.Should().Be(200m);
    }

    [Fact]
    public async Task DataIsolation_MemberCreateMutatesTheActiveHouseholdOnly()
    {
        // PPL-058 (P0) — member CRUD from household B writes into B (the active household), never
        // into the caller's other household. Creating a person while acting as "houseB" must not
        // appear in "own".
        await using var db = NewContext();
        var chrisOwn = await SeedMember(db, "own", "Alex", 500m);
        await SeedMember(db, "houseB", "Alex", 3000m);

        var created = await new CreateHouseholdMemberCommandHandler(db, new CurrentUserStub("houseB"))
            .Handle(new CreateHouseholdMemberCommand("Sam", 800m, null), CancellationToken.None);

        // "own" is untouched — still just its one member.
        var ownMembers = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("own"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        ownMembers.Should().ContainSingle().Which.Id.Should().Be(chrisOwn.Id);

        // The new person landed in household B.
        var bMembers = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("houseB"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        bMembers.Select(m => m.Name).Should().BeEquivalentTo(new[] { "Alex", "Sam" });
        (await db.HouseholdMembers.SingleAsync(m => m.Id == created.Id)).OwnerId.Should().Be("houseB");
    }

    // ---- PPL-077: restore an archived member via {archived:false} (reverse of PPL-031) -

    [Fact]
    public async Task RestoreArchivedMember_ReAddsToDefaultList_AndRecomputesIncomeShares()
    {
        // PPL-077 (P1) — ArchiveHouseholdMemberCommand(Id, Archived) is a set-to-value toggle,
        // so {archived:false} RESTORES. The handler re-sums totalActiveNet over the now-larger
        // active pool. Starting solo (Sam archived → Alex alone at 100%, combined €3,000), a
        // restore must return Sam to the default list, recompute shares to 75/25 against the
        // restored €4,000 pool (not the stale €3,000 divisor), and carry her original income back.
        // The restore leg has no UI control and was never exercised.
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, archived: true, order: 1);

        // Baseline: solo — the default list is Alex alone at 100%.
        var before = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        before.Should().ContainSingle().Which.IncomeSharePct.Should().Be(1m);

        var restored = await new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveHouseholdMemberCommand(sam.Id, Archived: false), CancellationToken.None);

        // The returned DTO reflects the restored active pool: share = 1000 / (3000 + 1000) = 0.25.
        restored.IsArchived.Should().BeFalse();
        restored.NetMonthlyIncome.Should().Be(1000m); // income intact — nothing was ever deleted
        restored.IncomeSharePct.Should().Be(0.25m);

        // Default list re-includes her, and both shares recompute against the €4,000 pool.
        var after = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        after.Should().HaveCount(2); // 2 active members → the data behind the shared/solo flip (PPL-031 inverse)
        after.Single(m => m.Id == alex.Id).IncomeSharePct.Should().Be(0.75m);
        after.Single(m => m.Id == sam.Id).IncomeSharePct.Should().Be(0.25m);
        (await db.HouseholdMembers.SingleAsync(m => m.Id == sam.Id)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task RestoreArchivedMember_ObeysOwnerScopingAndNotFound()
    {
        // PPL-077 (P1) — the restore leg is the same handler as archive, so it enforces the same
        // guards: a member owned by another household → 403 (ForbiddenAccessException); an unknown
        // id → 404 (NotFoundException). Neither guard was pinned for the {archived:false} path.
        await using var db = NewContext();
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, archived: true);

        // Another login trying to restore user-1's member is forbidden.
        await Assert.ThrowsAsync<ForbiddenAccessException>(() =>
            new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-2"))
                .Handle(new ArchiveHouseholdMemberCommand(sam.Id, Archived: false), CancellationToken.None));

        // An unknown member id is a 404.
        await Assert.ThrowsAsync<NotFoundException>(() =>
            new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new ArchiveHouseholdMemberCommand(Guid.NewGuid(), Archived: false), CancellationToken.None));

        // The forbidden attempt changed nothing.
        (await db.HouseholdMembers.SingleAsync(m => m.Id == sam.Id)).IsArchived.Should().BeTrue();
    }

    // ---- PPL-073: income shares when total active income is zero (no divide-by-zero) --

    [Fact]
    public async Task AllZeroActiveIncome_EveryShareIsZero_ThenRecomputesWhenIncomeIsAdded()
    {
        // PPL-073 (P1) — when the active pool's total net income is 0 the DTO mapping returns a 0
        // share for every member (the `totalActiveNet > 0` guard), so there is no divide-by-zero
        // and no NaN/Infinity. Adding income to one member makes the shares recompute against the
        // new pool. Existing coverage only exercises a non-zero pool (6000/4000).
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 0m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 0m, order: 1);

        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));
        var zero = await handler.Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        zero.Should().OnlyContain(m => m.IncomeSharePct == 0m);
        zero.Sum(m => m.NetMonthlyIncome).Should().Be(0m);

        // Give Alex an income; the pool becomes 1000 and the shares recompute (100% / 0%).
        await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Alex", 1000m, null), CancellationToken.None);

        var recomputed = await handler.Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        recomputed.Single(m => m.Id == alex.Id).IncomeSharePct.Should().Be(1m);
        recomputed.Single(m => m.Id == sam.Id).IncomeSharePct.Should().Be(0m);
    }

    // ---- PPL-025: includeArchived leaves an archived earner a non-zero share ----------

    [Fact]
    public async Task IncludeArchived_ArchivedEarnerKeepsNonZeroShare_SoSharesCanExceed100()
    {
        // PPL-025 (P2, regression lock) — contrary to the handler comment ("archived members get a
        // 0 share"), HouseholdMemberDto.ToDto applies income/totalActiveNet to EVERY member it maps,
        // including archived ones. So GET /members?includeArchived=true returns an archived earner
        // with a non-zero share and the shares across the full list can sum past 100%. The default
        // (active-only) list is unaffected. This pins the documented mapping quirk.
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, archived: true, order: 1);
        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));

        var all = await handler.Handle(new GetHouseholdMembersQuery(IncludeArchived: true), CancellationToken.None);
        // totalActiveNet excludes Sam (= 3000), but the mapping still divides HER income by it.
        all.Single(m => m.Id == sam.Id).IncomeSharePct.Should().Be(0.3333m); // 1000 / 3000, 4dp away-from-zero
        all.Single(m => m.Id == alex.Id).IncomeSharePct.Should().Be(1m);     // 3000 / 3000
        all.Sum(m => m.IncomeSharePct).Should().BeGreaterThan(1m);            // exceeds 100%

        // The default list the People UI actually requests is unaffected: Alex alone at 100%.
        var active = await handler.Handle(new GetHouseholdMembersQuery(), CancellationToken.None);
        active.Should().ContainSingle().Which.IncomeSharePct.Should().Be(1m);
    }

    // ---- PPL-075 / PPL-076: foreign/bogus personal savings account rejected -----------

    [Fact]
    public async Task CreateWithForeignOrBogusSavingsAccount_Throws_AndPersistsNoMember()
    {
        // PPL-075 (P2, API-surface) — the personal-savings account is a soft hint with no FK, so
        // the create handler requires an Account with that id owned by THIS household, else 404
        // "Account {id} was not found." The guard runs BEFORE HouseholdMembers.Add, so a foreign
        // or nonexistent id persists no member row (and never links across households). Existing
        // tests assert the throw but not the no-write.
        await using var db = NewContext();
        var foreign = await SeedAccount(db, "user-2", "Mallory-Savings"); // another household's account
        var handler = new CreateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"));

        var foreignEx = await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new CreateHouseholdMemberCommand("Sam", 500m, foreign.Id), CancellationToken.None));
        foreignEx.Message.Should().Contain("was not found");

        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new CreateHouseholdMemberCommand("Sam", 500m, Guid.NewGuid()), CancellationToken.None));

        // No member row was written in either household — the guard fired before the insert.
        (await db.HouseholdMembers.AnyAsync(m => m.OwnerId == "user-1")).Should().BeFalse();
        (await db.HouseholdMembers.AnyAsync(m => m.OwnerId == "user-2")).Should().BeFalse();
    }

    [Fact]
    public async Task UpdateWithForeignOrBogusSavingsAccount_Throws_AndLeavesRowUnchanged()
    {
        // PPL-076 (P2, API-surface) — the update handler runs the same soft-hint ownership check
        // AFTER the member-exists/owner guards but BEFORE assigning any field or saving. A foreign
        // or nonexistent savings id → 404 with no partial write: name, income and the existing
        // (owned) savings link are all left exactly as they were.
        await using var db = NewContext();
        var ownSav = await SeedAccount(db, "user-1", "Own-Savings");
        var foreign = await SeedAccount(db, "user-2", "Mallory-Savings");
        var sam = await SeedMember(db, "user-1", "Sam", 1000m);
        sam.PersonalSavingsAccountId = ownSav.Id;
        await db.SaveChangesAsync();

        var handler = new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"));

        // Both failing updates also try to change the name/income — proving the throw precedes any
        // field assignment (nothing must stick).
        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new UpdateHouseholdMemberCommand(sam.Id, "Sam CHANGED", 9999m, foreign.Id), CancellationToken.None));
        await Assert.ThrowsAsync<NotFoundException>(() =>
            handler.Handle(new UpdateHouseholdMemberCommand(sam.Id, "Sam CHANGED", 9999m, Guid.NewGuid()), CancellationToken.None));

        var saved = await db.HouseholdMembers.SingleAsync(m => m.Id == sam.Id);
        saved.Name.Should().Be("Sam");
        saved.NetMonthlyIncome.Should().Be(1000m);
        saved.PersonalSavingsAccountId.Should().Be(ownSav.Id); // the owned link is untouched
    }
}
