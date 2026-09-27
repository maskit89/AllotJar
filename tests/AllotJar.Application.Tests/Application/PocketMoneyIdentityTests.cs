using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation.Commands.SyncPocketMoneyLines;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetMemberArchivePreview;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// W11 (REVIEW A6): a person's pocket-money budget line is linked to their id, not their display
/// name — a rename reuses the line (rule 53) — and archiving the person stops their planned pocket
/// money from next month onward, asking about the current month's remainder and never touching a
/// recorded payment (rule 54). "Current month" is the real UTC month, as the handlers resolve it.
/// </summary>
public class PocketMoneyIdentityTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-pocket-identity-{Guid.NewGuid()}")
            .Options);

    /// <summary>The real current month shifted by <paramref name="months"/> — the handlers read UTC "now".</summary>
    private static (int Year, int Month) Shift(int months)
    {
        var d = new DateTime(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1).AddMonths(months);
        return (d.Year, d.Month);
    }

    private static HouseholdMember SeedMember(ApplicationDbContext db, string name, int order, bool archived = false)
    {
        var m = new HouseholdMember { OwnerId = Owner, Name = name, NetMonthlyIncome = 1000m, DisplayOrder = order, IsArchived = archived };
        db.HouseholdMembers.Add(m);
        db.SaveChanges();
        return m;
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
                new() { Order = 2, Type = AllocationRuleType.FixedPerMember, Split = SplitMethod.Equal, FixedAmountPerMember = pocketEach },
                new() { Order = 3, Type = AllocationRuleType.SplitRemainderToMembers, Split = SplitMethod.Equal },
            },
        });
        db.SaveChanges();
    }

    /// <summary>A month holding a flagged "Pocket Money" group with the given lines (name, planned, linked person).</summary>
    private static BudgetMonth SeedMonthWithPocketLines(
        ApplicationDbContext db, (int Year, int Month) when, params (string Name, decimal Planned, Guid? MemberId)[] lines)
    {
        var month = new BudgetMonth
        {
            OwnerId = Owner, Year = when.Year, Month = when.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
                new()
                {
                    Name = SyncPocketMoneyLinesCommandHandler.CategoryName, Kind = CategoryKind.Expense,
                    ExcludeFromAllocation = true, DisplayOrder = 0,
                    Items = lines.Select((l, i) => new BudgetItem
                    {
                        Name = l.Name, PlannedAmount = l.Planned, MemberId = l.MemberId, DisplayOrder = i,
                    }).ToList(),
                },
            },
        };
        db.BudgetMonths.Add(month);
        db.SaveChanges();
        return month;
    }

    private static BudgetItem PocketLine(ApplicationDbContext db, BudgetMonth month, Guid memberId) =>
        db.BudgetItems.AsNoTracking()
            .Single(i => i.BudgetCategory.BudgetMonthId == month.Id && i.BudgetCategory.Kind == CategoryKind.Expense && i.MemberId == memberId);

    private static List<BudgetItem> PocketLines(ApplicationDbContext db, BudgetMonth month) =>
        db.BudgetItems.AsNoTracking()
            .Where(i => i.BudgetCategory.BudgetMonthId == month.Id && i.BudgetCategory.Kind == CategoryKind.Expense)
            .OrderBy(i => i.DisplayOrder)
            .ToList();

    private static Transaction Pay(ApplicationDbContext db, BudgetItem line, decimal amount, (int Year, int Month) when)
    {
        var t = new Transaction
        {
            OwnerId = Owner, BudgetItemId = line.Id, Amount = amount, Type = TransactionType.Expense,
            Date = new DateOnly(when.Year, when.Month, 5), Payee = "Pocket money",
        };
        db.Transactions.Add(t);
        db.SaveChanges();
        return t;
    }

    private static Task<HouseholdMemberDtoLike> ArchiveAsync(ApplicationDbContext db, Guid id, PocketMoneyDecision? decision = null, bool archived = true) =>
        new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new ArchiveHouseholdMemberCommand(id, archived, decision), CancellationToken.None)
            .ContinueWith(t => new HouseholdMemberDtoLike(t.Result.IsArchived));

    private sealed record HouseholdMemberDtoLike(bool IsArchived);

    // ---- Rule 53: identity, not name -------------------------------------------------------

    [Fact]
    public async Task Sync_LinksEachLineToItsPerson_AndARenameReusesTheLine()
    {
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var july = SeedMonthWithPocketLines(db, (2026, 7));
        var sync = new SyncPocketMoneyLinesCommandHandler(db, new CurrentUserStub(Owner));

        await sync.Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        PocketLines(db, july).Select(i => (i.Name, i.PlannedAmount, i.MemberId))
            .Should().Equal(("Alex", 250m, (Guid?)alex.Id), ("Robin", 250m, (Guid?)robin.Id));

        // Rename the person: the linked line shows the new name, the amount and total do not move.
        await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Alexander", 1000m, null), CancellationToken.None);
        PocketLines(db, july).Select(i => (i.Name, i.PlannedAmount, i.MemberId))
            .Should().Equal(("Alexander", 250m, (Guid?)alex.Id), ("Robin", 250m, (Guid?)robin.Id));

        // Syncing again reuses the linked line — no "Alexander" beside a stale "Alex".
        var dto = await sync.Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);
        var pocket = dto.Categories.Single(c => c.Name == SyncPocketMoneyLinesCommandHandler.CategoryName);
        pocket.Items.Should().HaveCount(2);
        pocket.TotalPlanned.Should().Be(500m);
        (await db.BudgetItems.CountAsync(i => i.MemberId == alex.Id)).Should().Be(1);
    }

    [Fact]
    public async Task Sync_AdoptsALegacyLineByName_AndLinksIt()
    {
        // Lines written before the link existed carry no MemberId; the first sync adopts the one
        // that matches the person's name (case-insensitively) instead of adding a second line.
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        var july = SeedMonthWithPocketLines(db, (2026, 7), ("alex", 99m, null));
        var legacyId = PocketLines(db, july).Single().Id;

        await new SyncPocketMoneyLinesCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        var line = PocketLines(db, july).Should().ContainSingle().Subject;
        line.Id.Should().Be(legacyId);
        line.MemberId.Should().Be(alex.Id);
        line.PlannedAmount.Should().Be(250m);
    }

    [Fact]
    public async Task Sync_LeavesAnArchivedPersonsLinkedLineAlone()
    {
        // An archived person's line is the archive's business (kept or cancelled there, rule 54):
        // the sync neither zeroes it, re-links it nor duplicates it.
        await using var db = NewContext();
        SeedProfile(db, 250m);
        var alex = SeedMember(db, "Alex", 0);
        var old = SeedMember(db, "Old", 1, archived: true);
        var july = SeedMonthWithPocketLines(db, (2026, 7), ("Old", 99m, old.Id));

        await new SyncPocketMoneyLinesCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new SyncPocketMoneyLinesCommand(2026, 7), CancellationToken.None);

        PocketLines(db, july).Select(i => (i.Name, i.PlannedAmount, i.MemberId))
            .Should().Equal(("Old", 99m, (Guid?)old.Id), ("Alex", 250m, (Guid?)alex.Id));
    }

    [Fact]
    public async Task Rename_FollowsEveryMonthsLinkedLine_ButKeepsACustomisedName()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var robin = SeedMember(db, "Robin", 1);
        var june = SeedMonthWithPocketLines(db, (2026, 6), ("Alex", 200m, alex.Id), ("Robin", 200m, robin.Id));
        var july = SeedMonthWithPocketLines(db, (2026, 7), ("Alex allowance", 250m, alex.Id), ("Robin", 250m, robin.Id));

        await new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new UpdateHouseholdMemberCommand(alex.Id, "Al", 1000m, null), CancellationToken.None);

        PocketLine(db, june, alex.Id).Name.Should().Be("Al");              // the person's name → follows
        PocketLine(db, july, alex.Id).Name.Should().Be("Alex allowance");  // a name of the user's own → kept
        PocketLine(db, july, robin.Id).Name.Should().Be("Robin");          // someone else's line → untouched
        PocketLine(db, june, alex.Id).PlannedAmount.Should().Be(200m);
    }

    // ---- Rule 54: archiving stops the plan from next month; this month is the user's call -------

    [Fact]
    public async Task Archive_ClearsFutureMonths_RemovingUntouchedLines_AndKeepingPaidOnes()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var sam = SeedMember(db, "Sam", 1);
        var past = SeedMonthWithPocketLines(db, Shift(-1), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));
        var next = SeedMonthWithPocketLines(db, Shift(1), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));
        var later = SeedMonthWithPocketLines(db, Shift(2), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));
        // A payment already recorded against a future line (a pre-paid allowance) must survive.
        var paid = Pay(db, PocketLine(db, later, sam.Id), 100m, Shift(2));

        var dto = await ArchiveAsync(db, sam.Id);
        dto.IsArchived.Should().BeTrue();

        // Next month: nothing recorded → the line is gone; Alex's stays.
        PocketLines(db, next).Select(i => (i.Name, i.PlannedAmount)).Should().Equal(("Alex", 250m));
        // The month after: the payment is kept and the plan drops to it — no money moved.
        PocketLines(db, later).Select(i => (i.Name, i.PlannedAmount)).Should().Equal(("Alex", 250m), ("Sam", 100m));
        (await db.Transactions.SingleAsync(t => t.Id == paid.Id)).BudgetItemId.Should().Be(PocketLine(db, later, sam.Id).Id);
        // History is history.
        PocketLines(db, past).Select(i => (i.Name, i.PlannedAmount)).Should().Equal(("Alex", 250m), ("Sam", 250m));
        // The group itself stays for the people who remain.
        (await db.BudgetCategories.CountAsync(c => c.Name == SyncPocketMoneyLinesCommandHandler.CategoryName)).Should().Be(3);
    }

    [Fact]
    public async Task Archive_ThisMonthWithARemainder_RequiresTheDecision()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Sam", 250m, sam.Id));
        Pay(db, PocketLine(db, current, sam.Id), 100m, Shift(0));

        var act = () => ArchiveAsync(db, sam.Id);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Should().ContainKey("PocketMoneyThisMonth")
            .WhoseValue.Single().Should().Contain("Sam still has 150.00 of pocket money planned");
        (await db.HouseholdMembers.SingleAsync(m => m.Id == sam.Id)).IsArchived.Should().BeFalse();
        PocketLine(db, current, sam.Id).PlannedAmount.Should().Be(250m);
    }

    [Fact]
    public async Task Archive_Keep_LeavesThisMonthsPlan_AndStillStopsNextMonth()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Sam", 250m, sam.Id));
        var next = SeedMonthWithPocketLines(db, Shift(1), ("Sam", 250m, sam.Id));

        var dto = await ArchiveAsync(db, sam.Id, PocketMoneyDecision.Keep);

        dto.IsArchived.Should().BeTrue();
        PocketLine(db, current, sam.Id).PlannedAmount.Should().Be(250m);
        PocketLines(db, next).Should().BeEmpty();

        // Restoring recreates nothing: the next sync would.
        (await ArchiveAsync(db, sam.Id, archived: false)).IsArchived.Should().BeFalse();
        PocketLines(db, next).Should().BeEmpty();
    }

    [Fact]
    public async Task Archive_Cancel_DropsThisMonthsPlanToWhatWasPaid_AndKeepsThePayment()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Sam", 250m, sam.Id));
        var line = PocketLine(db, current, sam.Id);
        var paid = Pay(db, line, 100m, Shift(0));
        var transactionsBefore = await db.Transactions.CountAsync();

        await ArchiveAsync(db, sam.Id, PocketMoneyDecision.Cancel);

        var after = PocketLine(db, current, sam.Id);
        after.Id.Should().Be(line.Id);
        after.PlannedAmount.Should().Be(100m); // the remaining 150.00 is cancelled; the 100.00 paid stands
        (await db.Transactions.CountAsync()).Should().Be(transactionsBefore);
        (await db.Transactions.SingleAsync(t => t.Id == paid.Id)).Amount.Should().Be(100m);
    }

    [Fact]
    public async Task Archive_Cancel_RemovesThisMonthsLine_WhenNothingWasRecorded()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var sam = SeedMember(db, "Sam", 1);
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));

        await ArchiveAsync(db, sam.Id, PocketMoneyDecision.Cancel);

        PocketLines(db, current).Select(i => (i.Name, i.PlannedAmount)).Should().Equal(("Alex", 250m));
    }

    [Fact]
    public async Task Archive_NeedsNoDecision_WhenNothingRemainsThisMonth_OrTheLineIsOverspent()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Sam", 250m, sam.Id));
        Pay(db, PocketLine(db, current, sam.Id), 300m, Shift(0)); // more paid than planned

        var dto = await ArchiveAsync(db, sam.Id);

        dto.IsArchived.Should().BeTrue();
        // An overspent line is never "raised to the paid amount" — it is left as it is.
        PocketLine(db, current, sam.Id).PlannedAmount.Should().Be(250m);
    }

    [Fact]
    public async Task Archive_LeavesIncomeLines_AndOtherPeoplesLinesAlone()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var sam = SeedMember(db, "Sam", 1);
        var next = SeedMonthWithPocketLines(db, Shift(1), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));
        var income = await db.BudgetCategories.SingleAsync(c => c.BudgetMonthId == next.Id && c.Kind == CategoryKind.Income);
        db.BudgetItems.Add(new BudgetItem { BudgetCategoryId = income.Id, Name = "Sam salary", PlannedAmount = 2000m, MemberId = sam.Id });
        await db.SaveChangesAsync();

        await ArchiveAsync(db, sam.Id);

        // Her income line is not pocket money — it stays attributed until the next copy folds it in.
        (await db.BudgetItems.SingleAsync(i => i.Name == "Sam salary")).MemberId.Should().Be(sam.Id);
        PocketLines(db, next).Select(i => i.Name).Should().Equal("Alex");
    }

    [Fact]
    public async Task Archive_IsOwnerScoped_BeforeItTouchesAnyLine()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        var next = SeedMonthWithPocketLines(db, Shift(1), ("Sam", 250m, sam.Id));

        var act = () => new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub("user-2"))
            .Handle(new ArchiveHouseholdMemberCommand(sam.Id), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
        PocketLines(db, next).Should().ContainSingle();
    }

    [Fact]
    public async Task ArchivePreview_ReportsThisMonthsRemainder_AndTheFutureMonthsToClear()
    {
        await using var db = NewContext();
        var sam = SeedMember(db, "Sam", 0);
        SeedMonthWithPocketLines(db, Shift(-1), ("Sam", 250m, sam.Id));
        var current = SeedMonthWithPocketLines(db, Shift(0), ("Sam", 250m, sam.Id));
        Pay(db, PocketLine(db, current, sam.Id), 100m, Shift(0));
        SeedMonthWithPocketLines(db, Shift(1), ("Sam", 250m, sam.Id));
        SeedMonthWithPocketLines(db, Shift(3), ("Sam", 300m, sam.Id));

        var preview = await new GetMemberArchivePreviewQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMemberArchivePreviewQuery(sam.Id), CancellationToken.None);

        preview.Name.Should().Be("Sam");
        preview.ThisMonth.Should().NotBeNull();
        preview.ThisMonth!.Planned.Should().Be(250m);
        preview.ThisMonth.Paid.Should().Be(100m);
        preview.ThisMonth.Remaining.Should().Be(150m);
        preview.FutureMonths.Select(m => ((m.Year, m.Month), m.Planned))
            .Should().Equal((Shift(1), 250m), (Shift(3), 300m)); // the past month is not offered

        // Nobody's pocket money: an empty preview, nothing to ask.
        var alex = SeedMember(db, "Alex", 1);
        var none = await new GetMemberArchivePreviewQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMemberArchivePreviewQuery(alex.Id), CancellationToken.None);
        none.ThisMonth.Should().BeNull();
        none.FutureMonths.Should().BeEmpty();
    }

    // ---- Month copy: an archived person's allowance does not roll forward ------------------

    [Fact]
    public async Task CreateMonth_Copy_DropsAnArchivedPersonsPocketLine_AndKeepsTheOthers()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "Alex", 0);
        var sam = SeedMember(db, "Sam", 1, archived: true);
        var june = SeedMonthWithPocketLines(db, (2026, 6), ("Alex", 250m, alex.Id), ("Sam", 250m, sam.Id));
        var income = await db.BudgetCategories.SingleAsync(c => c.BudgetMonthId == june.Id && c.Kind == CategoryKind.Income);
        db.BudgetItems.Add(new BudgetItem { BudgetCategoryId = income.Id, Name = "Sam salary", PlannedAmount = 2000m, MemberId = sam.Id });
        await db.SaveChangesAsync();

        var july = await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub(Owner))
            .Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        var pocket = july.Categories.Single(c => c.Name == SyncPocketMoneyLinesCommandHandler.CategoryName);
        pocket.Items.Select(i => (i.Name, i.PlannedAmount, i.MemberId)).Should().Equal(("Alex", 250m, (Guid?)alex.Id));
        // Her income line still copies, as whole-household income (the W06 rule).
        july.Categories.Single(c => c.Kind == "Income").Items
            .Select(i => (i.Name, i.PlannedAmount, i.MemberId)).Should().Equal(("Sam salary", 2000m, (Guid?)null));
    }
}
