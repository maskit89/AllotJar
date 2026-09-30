using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// ALLOC-068.. — the one-click sync that materializes the profile's pocket money as
/// per-member budget lines in an ExcludeFromAllocation Expense category, so the
/// zero-based budget's "zero" can include pocket money without the engine deducting
/// it twice.
/// </summary>
public class SyncPocketMoneyLinesTests
{
    private static void SeedProfile(ApplicationDbContext db, string owner, decimal pocketEach)
    {
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = owner,
            Name = "Household allocation",
            Rules = new List<AllocationRule>
            {
                new() { Order = 0, Type = AllocationRuleType.FundEnvelopes, Split = SplitMethod.Equal },
                new() { Order = 1, Type = AllocationRuleType.FundJars, Split = SplitMethod.Equal },
                new() { Order = 2, Type = AllocationRuleType.FixedPerMember, Split = SplitMethod.Equal, FixedAmountPerMember = pocketEach },
                new() { Order = 3, Type = AllocationRuleType.SplitRemainderToMembers, Split = SplitMethod.Equal },
            },
        });
        db.SaveChanges();
    }

    private static void SeedMembers(ApplicationDbContext db, string owner, params string[] names)
    {
        var order = 0;
        foreach (var name in names)
        {
            db.HouseholdMembers.Add(new HouseholdMember
            {
                OwnerId = owner, Name = name, NetMonthlyIncome = 1500m, DisplayOrder = order++,
            });
        }
        db.SaveChanges();
    }

    private static BudgetMonth SeedMonth(ApplicationDbContext db, string owner, params BudgetCategory[] categories)
    {
        var month = new BudgetMonth
        {
            OwnerId = owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = categories.ToList(),
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return month;
    }

    private static SyncPocketMoneyLinesCommandHandler Handler(ApplicationDbContext db, string owner = "user-1") =>
        new(db, new CurrentUserStub(owner));

    [Fact]
    public async Task Sync_CreatesFlaggedCategory_WithOneLinePerActiveMember()
    {
        await using var db = NewContext();
        SeedProfile(db, "user-1", 250m);
        SeedMembers(db, "user-1", "Alex", "Robin");
        SeedMonth(db, "user-1",
            new BudgetCategory { Name = "Living", Kind = CategoryKind.Expense, Items = { new BudgetItem { Name = "Rent", PlannedAmount = 2000m } } });

        var dto = await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var pocket = dto.Categories.Single(c => c.Name == "Pocket Money");
        pocket.Kind.Should().Be("Expense");
        pocket.ExcludeFromAllocation.Should().BeTrue();
        pocket.Items.Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Alex", 250m), ("Robin", 250m) });
        // The budget's planned total now includes pocket money — that is the point.
        dto.TotalPlanned.Should().Be(2000m + 500m);
    }

    [Fact]
    public async Task Sync_IsIdempotent_AndFollowsAChangedPocketAmount()
    {
        await using var db = NewContext();
        SeedProfile(db, "user-1", 250m);
        SeedMembers(db, "user-1", "Alex", "Robin");
        SeedMonth(db, "user-1");

        await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        var profile = await db.AllocationProfiles.Include(p => p.Rules).SingleAsync();
        profile.Rules.Single(r => r.Type == AllocationRuleType.FixedPerMember).FixedAmountPerMember = 300m;
        await db.SaveChangesAsync();

        var dto = await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var pocket = dto.Categories.Single(c => c.Name == "Pocket Money");
        pocket.Items.Should().HaveCount(2);
        pocket.Items.Select(i => i.PlannedAmount).Should().OnlyContain(a => a == 300m);
        (await db.BudgetCategories.CountAsync(c => c.Name == "Pocket Money")).Should().Be(1);
    }

    [Fact]
    public async Task Sync_AdoptsAnUnflaggedPocketMoneyCategory_HealingTheDoubleCount()
    {
        await using var db = NewContext();
        SeedProfile(db, "user-1", 250m);
        SeedMembers(db, "user-1", "Alex", "Robin");
        // The imported-household shape: a REAL unflagged "Pocket Money" envelope + the rule.
        SeedMonth(db, "user-1",
            new BudgetCategory { Name = "Living", Kind = CategoryKind.Expense, Items = { new BudgetItem { Name = "Rent", PlannedAmount = 2000m } } },
            new BudgetCategory
            {
                Name = "Pocket Money", Kind = CategoryKind.Expense,
                Items = { new BudgetItem { Name = "Alex", PlannedAmount = 250m }, new BudgetItem { Name = "Robin", PlannedAmount = 250m } },
            });

        var before = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);
        // Unflagged: the envelope total still contains the 500 of pocket lines → double count.
        before.EnvelopesTotal.Should().Be(2500m);

        var dto = await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        dto.Categories.Count(c => string.Equals(c.Name, "Pocket Money", StringComparison.OrdinalIgnoreCase)).Should().Be(1);
        dto.Categories.Single(c => c.Name == "Pocket Money").ExcludeFromAllocation.Should().BeTrue();

        var after = await new PreviewIncomeAllocationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new PreviewIncomeAllocationQuery(2026, 7, null), CancellationToken.None);
        // Flagged: the envelopes drop to the real costs; the rule is now the single deduction.
        after.EnvelopesTotal.Should().Be(2000m);
    }

    [Fact]
    public async Task Sync_SkipsArchivedMembers_AndLeavesUnmatchedLinesAlone()
    {
        await using var db = NewContext();
        SeedProfile(db, "user-1", 250m);
        SeedMembers(db, "user-1", "Alex");
        db.HouseholdMembers.Add(new HouseholdMember { OwnerId = "user-1", Name = "Old Flame", IsArchived = true, DisplayOrder = 9 });
        db.SaveChanges();
        SeedMonth(db, "user-1",
            new BudgetCategory
            {
                Name = "Pocket Money", Kind = CategoryKind.Expense, ExcludeFromAllocation = true,
                Items = { new BudgetItem { Name = "Somebody Renamed", PlannedAmount = 99m } },
            });

        var dto = await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var pocket = dto.Categories.Single(c => c.Name == "Pocket Money");
        pocket.Items.Select(i => (i.Name, i.PlannedAmount)).Should().BeEquivalentTo(new[]
        {
            ("Somebody Renamed", 99m), // left untouched — visible leftovers beat silent deletion
            ("Alex", 250m),
        });
        pocket.Items.Should().NotContain(i => i.Name == "Old Flame");
    }

    [Fact]
    public async Task Sync_WithPocketZero_ZeroesTheExistingLines()
    {
        await using var db = NewContext();
        SeedProfile(db, "user-1", 0m);
        SeedMembers(db, "user-1", "Alex", "Robin");
        SeedMonth(db, "user-1",
            new BudgetCategory
            {
                Name = "Pocket Money", Kind = CategoryKind.Expense, ExcludeFromAllocation = true,
                Items = { new BudgetItem { Name = "Alex", PlannedAmount = 250m }, new BudgetItem { Name = "Robin", PlannedAmount = 250m } },
            });

        var dto = await Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        dto.Categories.Single(c => c.Name == "Pocket Money")
            .Items.Select(i => i.PlannedAmount).Should().OnlyContain(a => a == 0m);
    }

    [Fact]
    public async Task Sync_Throws_WhenNoProfile_OrNoMonth_OrForeignOwner()
    {
        await using var db = NewContext();

        // No profile at all.
        var noProfile = () => Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        await noProfile.Should().ThrowAsync<NotFoundException>();

        // Profile but no month.
        SeedProfile(db, "user-1", 250m);
        SeedMembers(db, "user-1", "Alex");
        var noMonth = () => Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        await noMonth.Should().ThrowAsync<NotFoundException>();

        // A month owned by someone else is invisible (owner-scoped load → NotFound).
        SeedMonth(db, "someone-else");
        var foreign = () => Handler(db).Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        await foreign.Should().ThrowAsync<NotFoundException>();
    }
}
