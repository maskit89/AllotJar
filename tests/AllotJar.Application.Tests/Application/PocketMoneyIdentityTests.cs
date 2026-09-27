using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rules 53 and 54 (W11): a person's pocket-money line is linked to their id, a rename reuses it,
/// and archiving stops the planned amounts from next month on while the current month keeps or
/// cancels its remainder and every recorded payment stays put.
/// </summary>
public class PocketMoneyIdentityTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly ICurrentUser User = new CurrentUserStub(Owner);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-pocket-identity-{Guid.NewGuid()}")
            .Options);

    private static (int Year, int Month) Shift((int Year, int Month) ym, int months)
    {
        var d = new DateOnly(ym.Year, ym.Month, 1).AddMonths(months);
        return (d.Year, d.Month);
    }

    private static void SeedProfile(ApplicationDbContext db, decimal pocketEach)
    {
        db.AllocationProfiles.Add(new AllocationProfile
        {
            OwnerId = Owner,
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

    private static HouseholdMember SeedMember(ApplicationDbContext db, string name, int order)
    {
        var m = new HouseholdMember { OwnerId = Owner, Name = name, NetMonthlyIncome = 1500m, DisplayOrder = order };
        db.HouseholdMembers.Add(m);
        db.SaveChanges();
        return m;
    }

    /// <summary>A month whose "Pocket Money" group already holds linked lines for the given people.</summary>
    private static BudgetMonth SeedMonthWithPocket(
        ApplicationDbContext db, (int Year, int Month) ym, params (HouseholdMember Member, decimal Planned)[] lines)
    {
        var category = new BudgetCategory
        {
            Name = SyncPocketMoneyLinesCommandHandler.CategoryName,
            Kind = CategoryKind.Expense,
            ExcludeFromAllocation = true,
        };
        var order = 0;
        foreach (var (member, planned) in lines)
        {
            category.Items.Add(new BudgetItem
            {
                Name = member.Name, MemberId = member.Id, PlannedAmount = planned, DisplayOrder = order++,
            });
        }
        var month = new BudgetMonth
        {
            OwnerId = Owner, Year = ym.Year, Month = ym.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = { new BudgetCategory { Name = "Income", Kind = CategoryKind.Income }, category },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return month;
    }

    private static Task<List<BudgetItem>> PocketLinesAsync(ApplicationDbContext db, (int Year, int Month) ym) =>
        db.BudgetItems
            .AsNoTracking()
            .Where(i => i.BudgetCategory.Kind == CategoryKind.Expense
                        && i.BudgetCategory.BudgetMonth.Year == ym.Year
                        && i.BudgetCategory.BudgetMonth.Month == ym.Month)
            .OrderBy(i => i.DisplayOrder)
            .ToListAsync();

    // ---- Rule 53: identity and rename -------------------------------------------------

    [Fact]
    public async Task Sync_LinksEachLineToThePerson()
    {
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        db.BudgetMonths.Add(new BudgetMonth { OwnerId = Owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur });
        await db.SaveChangesAsync();

        await new SyncPocketMoneyLinesCommandHandler(db, User)
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var lines = await PocketLinesAsync(db, (2026, 7));
        lines.Select(i => (i.Name, i.MemberId, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Alex", (Guid?)alex.Id, 250m), ("Robin", (Guid?)robin.Id, 250m) });
    }

    [Fact]
    public async Task Sync_AdoptsALegacyLineByName_AndStampsThePerson()
    {
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories =
            {
                new BudgetCategory
                {
                    Name = "Pocket Money", Kind = CategoryKind.Expense, ExcludeFromAllocation = true,
                    Items = { new BudgetItem { Name = "alex", PlannedAmount = 100m } },
                },
            },
        });
        await db.SaveChangesAsync();

        await new SyncPocketMoneyLinesCommandHandler(db, User)
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var lines = await PocketLinesAsync(db, (2026, 7));
        lines.Should().ContainSingle();
        lines[0].MemberId.Should().Be(alex.Id);
        lines[0].Name.Should().Be("Alex");
        lines[0].PlannedAmount.Should().Be(250m);
    }

    [Fact]
    public async Task Rename_ThenSync_ReusesTheLinkedLine_NoDuplicate_SameTotal()
    {
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        db.BudgetMonths.Add(new BudgetMonth { OwnerId = Owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur });
        await db.SaveChangesAsync();
        await new SyncPocketMoneyLinesCommandHandler(db, User)
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        await new UpdateHouseholdMemberCommandHandler(db, User)
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Alexandra", 1500m, null), CancellationToken.None);

        // The rename alone updated the displayed name; nothing else moved.
        var afterRename = await PocketLinesAsync(db, (2026, 7));
        afterRename.Select(i => i.Name).Should().BeEquivalentTo(new[] { "Alexandra", "Robin" });
        afterRename.Sum(i => i.PlannedAmount).Should().Be(500m);

        var dto = await new SyncPocketMoneyLinesCommandHandler(db, User)
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var pocket = dto.Categories.Single(c => c.Name == "Pocket Money");
        pocket.Items.Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Alexandra", 250m), ("Robin", 250m) });
        (await db.BudgetItems.CountAsync(i => i.MemberId == alex.Id)).Should().Be(1);
        (await db.BudgetItems.CountAsync(i => i.MemberId == robin.Id)).Should().Be(1);
    }

    [Fact]
    public async Task Rename_LeavesIncomeAttributionAndOtherPeoplesLinesAlone()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var month = SeedMonthWithPocket(db, (2026, 7), (alex, 250m), (robin, 250m));
        var income = month.Categories.Single(c => c.Kind == CategoryKind.Income);
        db.BudgetItems.Add(new BudgetItem { BudgetCategoryId = income.Id, Name = "Salary", PlannedAmount = 3000m, MemberId = alex.Id });
        await db.SaveChangesAsync();

        await new UpdateHouseholdMemberCommandHandler(db, User)
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Alexandra", 1500m, null), CancellationToken.None);

        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Name == "Salary")).MemberId.Should().Be(alex.Id);
        (await PocketLinesAsync(db, (2026, 7))).Select(i => i.Name).Should().BeEquivalentTo(new[] { "Alexandra", "Robin" });
    }

    // ---- Rule 54: archive ---------------------------------------------------------------

    [Fact]
    public async Task Archive_RemovesFutureMonthsLines_KeepsCurrentByDefault_LeavesThePast()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var now = PocketMoneyLines.CurrentMonth();
        SeedMonthWithPocket(db, Shift(now, -1), (alex, 250m), (robin, 250m));
        SeedMonthWithPocket(db, now, (alex, 250m), (robin, 250m));
        SeedMonthWithPocket(db, Shift(now, 1), (alex, 250m), (robin, 250m));
        SeedMonthWithPocket(db, Shift(now, 2), (alex, 250m), (robin, 250m));

        await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(alex.Id), CancellationToken.None);

        (await PocketLinesAsync(db, Shift(now, -1))).Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Alex", 250m), ("Robin", 250m) }, "history is preserved");
        (await PocketLinesAsync(db, now)).Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Alex", 250m), ("Robin", 250m) }, "the current month is kept unless cancelled");
        (await PocketLinesAsync(db, Shift(now, 1))).Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Robin", 250m) });
        (await PocketLinesAsync(db, Shift(now, 2))).Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Robin", 250m) });
    }

    [Fact]
    public async Task Archive_CancelCurrentMonth_CutsTheRemainderToWhatWasPaid_AndKeepsThePayments()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var now = PocketMoneyLines.CurrentMonth();
        var month = SeedMonthWithPocket(db, now, (alex, 250m));
        var line = month.Categories.Single(c => c.Kind == CategoryKind.Expense).Items.Single();
        var paid = new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(now.Year, now.Month, 5), Payee = "Cash",
            Amount = 100m, Type = TransactionType.Expense, BudgetItemId = line.Id, MemberId = alex.Id,
        };
        db.Transactions.Add(paid);
        await db.SaveChangesAsync();

        await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(alex.Id, CancelCurrentMonthPocketMoney: true), CancellationToken.None);

        var after = (await PocketLinesAsync(db, now)).Single();
        after.PlannedAmount.Should().Be(100m, "the remaining 150 is cancelled; the 100 paid stays planned");
        var tx = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == paid.Id);
        tx.BudgetItemId.Should().Be(line.Id);
        tx.Amount.Should().Be(100m);
    }

    [Fact]
    public async Task Archive_FutureLineWithARecordedPayment_IsCutNotRemoved()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var now = PocketMoneyLines.CurrentMonth();
        var next = Shift(now, 1);
        var month = SeedMonthWithPocket(db, next, (alex, 250m));
        var line = month.Categories.Single(c => c.Kind == CategoryKind.Expense).Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(next.Year, next.Month, 1), Payee = "Advance",
            Amount = 40m, Type = TransactionType.Expense, BudgetItemId = line.Id,
        });
        await db.SaveChangesAsync();

        await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(alex.Id), CancellationToken.None);

        var after = (await PocketLinesAsync(db, next)).Single();
        after.Id.Should().Be(line.Id);
        after.PlannedAmount.Should().Be(40m);
        (await db.Transactions.CountAsync(t => t.BudgetItemId == line.Id)).Should().Be(1);
    }

    [Fact]
    public async Task Archive_DoesNotTouchAccountMoney_OrOtherPeoplesLines()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var now = PocketMoneyLines.CurrentMonth();
        SeedMonthWithPocket(db, Shift(now, 1), (alex, 250m), (robin, 300m));
        var txCountBefore = await db.Transactions.CountAsync();

        await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(alex.Id, CancelCurrentMonthPocketMoney: true), CancellationToken.None);

        (await db.Transactions.CountAsync()).Should().Be(txCountBefore);
        (await PocketLinesAsync(db, Shift(now, 1))).Select(i => (i.Name, i.PlannedAmount))
            .Should().BeEquivalentTo(new[] { ("Robin", 300m) });
    }

    [Fact]
    public async Task Restore_DoesNotRecreateLines()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var now = PocketMoneyLines.CurrentMonth();
        SeedMonthWithPocket(db, Shift(now, 1), (alex, 250m));
        var handler = new ArchiveHouseholdMemberCommandHandler(db, User);
        await handler.Handle(new ArchiveHouseholdMemberCommand(alex.Id), CancellationToken.None);

        await handler.Handle(new ArchiveHouseholdMemberCommand(alex.Id, Archived: false), CancellationToken.None);

        (await PocketLinesAsync(db, Shift(now, 1))).Should().BeEmpty("the sync re-adds a restored person on request");
    }

    [Fact]
    public async Task CopyingAMonth_DropsAnArchivedPersonsPocketLine()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        SeedMonthWithPocket(db, (2026, 6), (alex, 250m), (robin, 250m));
        alex.IsArchived = true;
        await db.SaveChangesAsync();

        var dto = await new CreateBudgetMonthCommandHandler(db, User)
            .Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        var pocket = dto.Categories.Single(c => c.Name == "Pocket Money");
        pocket.Items.Select(i => (i.Name, i.PlannedAmount, i.MemberId))
            .Should().BeEquivalentTo(new[] { ("Robin", 250m, (Guid?)robin.Id) });
    }

    // ---- The People page's figures for the archive dialog --------------------------------

    [Fact]
    public async Task Members_CarryThisMonthsPocketMoney_PlannedPaidRemaining()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var now = PocketMoneyLines.CurrentMonth();
        var month = SeedMonthWithPocket(db, now, (alex, 250m));
        var line = month.Categories.Single(c => c.Kind == CategoryKind.Expense).Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(now.Year, now.Month, 3), Payee = "Cash",
            Amount = 60m, Type = TransactionType.Expense, BudgetItemId = line.Id,
        });
        await db.SaveChangesAsync();

        var members = await new GetHouseholdMembersQueryHandler(db, User)
            .Handle(new GetHouseholdMembersQuery(false, 2025, 1), CancellationToken.None);

        var a = members.Single(m => m.Id == alex.Id);
        a.PocketMoneyThisMonth.Should().NotBeNull();
        a.PocketMoneyThisMonth!.Planned.Should().Be(250m);
        a.PocketMoneyThisMonth.Paid.Should().Be(60m);
        a.PocketMoneyThisMonth.Remaining.Should().Be(190m);
        members.Single(m => m.Id == robin.Id).PocketMoneyThisMonth.Should().BeNull();
    }
}
