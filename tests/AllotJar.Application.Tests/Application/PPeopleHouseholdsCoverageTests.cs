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
/// income divide-by-zero guard (PPL-073); an archived member fetched with
/// <c>includeArchived=true</c> having a zero share while their month's lines are shared by the
/// active people (PPL-025); and
/// the guard-before-write on a foreign/bogus personal savings account for both create and
/// update (PPL-075 / PPL-076). Conventions mirror HouseholdMembersTests / MemberSpendingTests
/// (EF InMemory context, CurrentUserStub whose OwnerId defaults to UserId, FluentAssertions 7).
/// Income and shares are read from a month's budget (rule 28): each share test seeds a budget
/// month with attributed income lines and asks for that month; the saved default
/// <c>NetMonthlyIncome</c> is only the People page's helper field and never a divisor.
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

    /// <summary>A budget month whose income lines are attributed to the given members (rule 28).</summary>
    private static async Task SeedIncomeMonth(
        ApplicationDbContext db, string ownerId, int year, int month, params (HouseholdMember Member, decimal Amount)[] lines)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income,
                    Items = lines.Select(l => new BudgetItem { Name = l.Member.Name, PlannedAmount = l.Amount, MemberId = l.Member.Id }).ToList(),
                },
            },
        });
        await db.SaveChangesAsync();
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
        // member list, the spending lens and the income shares (her June income line stays in the
        // budget and folds into the household's income, rule 28), but her HouseholdMember row
        // and every transaction attributed to her stay exactly where they were. Existing tests
        // cover archive-hides-from-default and spending-excludes-archived, but never assert the
        // transactions survive the archive.
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, order: 1);
        await SeedIncomeMonth(db, "user-1", 2026, 6, (alex, 3000m), (sam, 1000m));
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

        // Default member list now excludes her; Alex carries the whole of June's income (share
        // 100%): Sam's 1,000 line is no longer hers, so it is shared among the active — Alex alone.
        var members = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 6), CancellationToken.None);
        members.Should().ContainSingle().Which.Name.Should().Be("Alex");
        members.Single().IncomeSharePct.Should().Be(1m); // 4000 / 4000
        members.Single().BudgetIncome.Should().Be(4000m); // 3000 attributed + Sam's 1000 now unattributed

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
        // so {archived:false} RESTORES. Shares are read from the month's budget (rule 28): while
        // Sam is archived her 1,000 income line is unattributed and Alex alone holds all €4,000
        // (100%); a restore must return Sam to the default list, give her line back to her, and
        // recompute the shares to 75/25 — and carry her saved default back untouched. The
        // handler's returned DTO reads the CURRENT month, so that is the month seeded here.
        // The restore leg has no UI control and was never exercised.
        await using var db = NewContext();
        var (year, month) = (DateTime.UtcNow.Year, DateTime.UtcNow.Month);
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, archived: true, order: 1);
        await SeedIncomeMonth(db, "user-1", year, month, (alex, 3000m), (sam, 1000m));

        // Baseline: solo — the default list is Alex alone at 100% of the month's €4,000.
        var before = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(Year: year, Month: month), CancellationToken.None);
        before.Should().ContainSingle().Which.IncomeSharePct.Should().Be(1m);
        before.Single().BudgetIncome.Should().Be(4000m);

        var restored = await new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveHouseholdMemberCommand(sam.Id, Archived: false), CancellationToken.None);

        // The returned DTO reflects the restored month: share = 1000 / (3000 + 1000) = 0.25.
        restored.IsArchived.Should().BeFalse();
        restored.NetMonthlyIncome.Should().Be(1000m); // the saved default is intact — nothing was ever deleted
        restored.BudgetIncome.Should().Be(1000m);     // her line is hers again
        restored.IncomeSharePct.Should().Be(0.25m);
        (restored.IncomeYear, restored.IncomeMonth).Should().Be((year, month));

        // Default list re-includes her, and both shares recompute against the €4,000 month.
        var after = await new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetHouseholdMembersQuery(Year: year, Month: month), CancellationToken.None);
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
        // PPL-073 (P1) — when the month's income is 0 (every line zero, or no budget month at
        // all) the share is 0 for every member (the `Total > 0` guard), so there is no
        // divide-by-zero and no NaN/Infinity. Adding an attributed income line to the month
        // makes the shares recompute; changing a saved default does not (rule 28). Existing
        // coverage only exercises a non-zero month (6000/4000).
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 0m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 0m, order: 1);
        await SeedIncomeMonth(db, "user-1", 2026, 6, (alex, 0m), (sam, 0m));

        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));
        var zero = await handler.Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 6), CancellationToken.None);
        zero.Should().OnlyContain(m => m.IncomeSharePct == 0m && m.BudgetIncome == 0m && m.HasBudget);
        zero.Sum(m => m.NetMonthlyIncome).Should().Be(0m);

        // A month with no budget at all is the same: zero for everyone, and flagged as such.
        var noMonth = await handler.Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 7), CancellationToken.None);
        noMonth.Should().OnlyContain(m => m.IncomeSharePct == 0m && m.BudgetIncome == 0m && !m.HasBudget);

        // Raising Alex's saved default changes nothing in the month: it is not an income figure.
        await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Alex", 1000m, null), CancellationToken.None);
        var stillZero = await handler.Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 6), CancellationToken.None);
        stillZero.Should().OnlyContain(m => m.IncomeSharePct == 0m);
        stillZero.Single(m => m.Id == alex.Id).NetMonthlyIncome.Should().Be(1000m);

        // Give Alex an income line in June; the month becomes 1000 and the shares recompute (100% / 0%).
        var alexLine = await db.BudgetItems.SingleAsync(i => i.MemberId == alex.Id);
        alexLine.PlannedAmount = 1000m;
        await db.SaveChangesAsync();

        var recomputed = await handler.Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 6), CancellationToken.None);
        recomputed.Single(m => m.Id == alex.Id).IncomeSharePct.Should().Be(1m);
        recomputed.Single(m => m.Id == sam.Id).IncomeSharePct.Should().Be(0m);
    }

    // ---- PPL-025: includeArchived shows an archived member with a zero share ----------

    [Fact]
    public async Task IncludeArchived_ArchivedMemberHasZeroShare_AndTheirLinesAreSharedByTheActive()
    {
        // PPL-025 (P2) — an archived member holds no income in any month (rule 28): the month's
        // lines attributed to them fold into the household's unattributed income and are shared
        // equally by the ACTIVE people. So GET /members?includeArchived=true returns the archived
        // member at income 0 / share 0, the shares across the full list still sum to exactly 100%,
        // and the default (active-only) list shows Alex alone holding the whole month.
        await using var db = NewContext();
        var alex = await SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var sam = await SeedMember(db, "user-1", "Sam", 1000m, archived: true, order: 1);
        await SeedIncomeMonth(db, "user-1", 2026, 6, (alex, 3000m), (sam, 1000m));
        var handler = new GetHouseholdMembersQueryHandler(db, new CurrentUserStub("user-1"));

        var all = await handler.Handle(new GetHouseholdMembersQuery(IncludeArchived: true, Year: 2026, Month: 6), CancellationToken.None);
        all.Should().HaveCount(2);
        var samDto = all.Single(m => m.Id == sam.Id);
        samDto.IsArchived.Should().BeTrue();
        samDto.BudgetIncome.Should().Be(0m);
        samDto.IncomeSharePct.Should().Be(0m);
        samDto.NetMonthlyIncome.Should().Be(1000m); // the saved default is still shown, it is just not income
        var alexDto = all.Single(m => m.Id == alex.Id);
        alexDto.BudgetIncome.Should().Be(4000m);  // 3000 attributed + Sam's 1000, now the household's
        alexDto.IncomeSharePct.Should().Be(1m);   // 4000 / 4000
        all.Sum(m => m.IncomeSharePct).Should().Be(1m);

        // The default list the People UI actually requests: Alex alone at 100%.
        var active = await handler.Handle(new GetHouseholdMembersQuery(Year: 2026, Month: 6), CancellationToken.None);
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
