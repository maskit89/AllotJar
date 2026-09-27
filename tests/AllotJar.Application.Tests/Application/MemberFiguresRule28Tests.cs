using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Allocation;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Household.Commands.CreateHouseholdMember;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Household.Queries.GetHouseholdMembers;
using AllotJar.Application.Household.Queries.GetMemberIncome;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Rule 28 on the People figures: every income and share a person is shown comes from the
/// selected month's budget — their attributed income lines plus an equal share of the
/// unattributed ones — and the saved per-person default (NetMonthlyIncome) is only a helper
/// for filling in a new budget, never a figure any calculation reads. Received income and
/// attributed spending are in the budget's base currency (rules 41–44): foreign rows convert
/// by their exchange rate and rows whose rate is still pending are counted, not summed.
/// </summary>
public class MemberFiguresRule28Tests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CurrencyCode Gbp = CurrencyCode.From("GBP");

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-member-figures-{Guid.NewGuid()}")
            .Options);

    private static async Task<HouseholdMember> SeedMember(
        ApplicationDbContext db, string name, decimal savedDefault, int order, bool archived = false)
    {
        var m = new HouseholdMember
        {
            OwnerId = Owner, Name = name, NetMonthlyIncome = savedDefault, DisplayOrder = order, IsArchived = archived,
        };
        db.HouseholdMembers.Add(m);
        await db.SaveChangesAsync();
        return m;
    }

    /// <summary>A budget month with one Income category; returns it so lines can be added.</summary>
    private static async Task<BudgetCategory> SeedMonth(ApplicationDbContext db, int year, int month)
    {
        var income = new BudgetCategory { Name = "Income", Kind = CategoryKind.Income };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { income },
        });
        await db.SaveChangesAsync();
        return income;
    }

    private static async Task AddIncomeLine(ApplicationDbContext db, BudgetCategory income, string name, decimal planned, Guid? memberId)
    {
        db.BudgetItems.Add(new BudgetItem { BudgetCategoryId = income.Id, Name = name, PlannedAmount = planned, MemberId = memberId });
        await db.SaveChangesAsync();
    }

    private static async Task<Transaction> AddTransaction(
        ApplicationDbContext db, TransactionType type, DateOnly date, decimal amount, Guid? memberId,
        CurrencyCode? currency = null, decimal rate = 1m, bool fxPending = false)
    {
        var t = new Transaction
        {
            OwnerId = Owner, Date = date, Payee = "x", Type = type, Amount = amount, MemberId = memberId,
            Currency = currency ?? CurrencyCode.Eur, ExchangeRate = rate, FxPending = fxPending,
        };
        db.Transactions.Add(t);
        await db.SaveChangesAsync();
        return t;
    }

    private static Task<IReadOnlyList<Household.Dtos.HouseholdMemberDto>> Members(
        ApplicationDbContext db, int year, int month, bool includeArchived = false) =>
        new GetHouseholdMembersQueryHandler(db, User)
            .Handle(new GetHouseholdMembersQuery(includeArchived, year, month), CancellationToken.None);

    // ---- GetHouseholdMembers ---------------------------------------------------------------

    [Fact]
    public async Task GetHouseholdMembers_BudgetIncome_IsAttributedLines_PlusAnEqualShareOfTheUnattributed()
    {
        await using var db = NewContext();
        var alex = await SeedMember(db, "Alex", 1m, 0);
        var robin = await SeedMember(db, "Robin", 1m, 1);
        var income = await SeedMonth(db, 2026, 7);
        await AddIncomeLine(db, income, "Alex — Salary", 3000m, alex.Id);
        await AddIncomeLine(db, income, "Robin — Salary", 1000m, robin.Id);
        await AddIncomeLine(db, income, "Child benefit", 500m, null); // 250 each

        var members = await Members(db, 2026, 7);

        var alexDto = members.Single(m => m.Id == alex.Id);
        var robinDto = members.Single(m => m.Id == robin.Id);
        alexDto.BudgetIncome.Should().Be(3250m);
        robinDto.BudgetIncome.Should().Be(1250m);
        alexDto.IncomeSharePct.Should().Be(0.7222m);  // 3250 / 4500
        robinDto.IncomeSharePct.Should().Be(0.2778m); // 1250 / 4500
        members.Should().OnlyContain(m => m.HasBudget && m.IncomeYear == 2026 && m.IncomeMonth == 7);
    }

    [Fact]
    public async Task GetHouseholdMembers_AMonthWithoutABudget_HasBudgetFalse_AndZeroFigures()
    {
        await using var db = NewContext();
        var alex = await SeedMember(db, "Alex", 9999m, 0);
        var robin = await SeedMember(db, "Robin", 8888m, 1);
        var income = await SeedMonth(db, 2026, 7); // only July exists
        await AddIncomeLine(db, income, "Alex — Salary", 3000m, alex.Id);
        await AddIncomeLine(db, income, "Robin — Salary", 1000m, robin.Id);

        var members = await Members(db, 2026, 8);

        members.Should().HaveCount(2);
        members.Should().OnlyContain(m => !m.HasBudget && m.BudgetIncome == 0m && m.IncomeSharePct == 0m);
        members.Should().OnlyContain(m => m.IncomeYear == 2026 && m.IncomeMonth == 8);
        // The saved defaults are still shown as what they are — a default — not as income.
        members.Single(m => m.Id == alex.Id).NetMonthlyIncome.Should().Be(9999m);
        members.Single(m => m.Id == robin.Id).NetMonthlyIncome.Should().Be(8888m);
    }

    [Fact]
    public async Task GetHouseholdMembers_TheSavedDefault_NeverAffectsBudgetIncomeOrShare()
    {
        await using var db = NewContext();
        var alex = await SeedMember(db, "Alex", 9999m, 0); // wildly different defaults...
        var robin = await SeedMember(db, "Robin", 1m, 1);
        var income = await SeedMonth(db, 2026, 7);
        await AddIncomeLine(db, income, "Alex — Salary", 2000m, alex.Id); // ...equal month income
        await AddIncomeLine(db, income, "Robin — Salary", 2000m, robin.Id);

        var before = await Members(db, 2026, 7);
        before.Should().OnlyContain(m => m.BudgetIncome == 2000m && m.IncomeSharePct == 0.5m);

        // Changing the default (the People page's field) leaves the month's figures untouched.
        await new UpdateHouseholdMemberCommandHandler(db, User)
            .Handle(new UpdateHouseholdMemberCommand(robin.Id, "Robin", 50000m, null), CancellationToken.None);

        var after = await Members(db, 2026, 7);
        after.Should().OnlyContain(m => m.BudgetIncome == 2000m && m.IncomeSharePct == 0.5m);
        after.Single(m => m.Id == robin.Id).NetMonthlyIncome.Should().Be(50000m);
    }

    // ---- GetMemberIncome ------------------------------------------------------------------

    [Fact]
    public async Task GetMemberIncome_Received_ConvertsForeignRows_AndSkipsFxPendingRows_CountingThem()
    {
        await using var db = NewContext();
        var alex = await SeedMember(db, "Alex", 0m, 0);
        var robin = await SeedMember(db, "Robin", 0m, 1);
        var income = await SeedMonth(db, 2026, 7);
        await AddIncomeLine(db, income, "Alex — Salary", 3000m, alex.Id);
        await AddIncomeLine(db, income, "Child benefit", 100m, null);

        // Alex: a GBP salary at 1.2 → 120 in base, a EUR row at face value, and a row whose rate
        // is still pending — left out and counted.
        await AddTransaction(db, TransactionType.Income, new DateOnly(2026, 7, 5), 100m, alex.Id, Gbp, rate: 1.2m);
        await AddTransaction(db, TransactionType.Income, new DateOnly(2026, 7, 6), 50m, alex.Id);
        await AddTransaction(db, TransactionType.Income, new DateOnly(2026, 7, 7), 999m, alex.Id, Gbp, rate: 1m, fxPending: true);
        // Robin: a slice of a GBP split converts by the parent's rate.
        var split = await AddTransaction(db, TransactionType.Income, new DateOnly(2026, 7, 8), 10m, null, Gbp, rate: 1.2m);
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, MemberId = robin.Id, Amount = 10m });
        await db.SaveChangesAsync();

        var dto = await new GetMemberIncomeQueryHandler(db, User)
            .Handle(new GetMemberIncomeQuery(2026, 7), CancellationToken.None);

        dto.HasBudget.Should().BeTrue();
        dto.FxPendingCount.Should().Be(1);
        dto.UnattributedPlanned.Should().Be(100m);
        var alexItem = dto.Items.Single(i => i.MemberId == alex.Id);
        var robinItem = dto.Items.Single(i => i.MemberId == robin.Id);
        alexItem.Received.Should().Be(170m, "120 (100 GBP × 1.2) + 50; the pending row is not summed");
        robinItem.Received.Should().Be(12m, "10 GBP slice × 1.2");

        // Income and share are the same figures SharesAsync gives — attributed + equal share of
        // the unattributed — so the People page and the allocation agree to the cent.
        var members = await db.HouseholdMembers.AsNoTracking().Where(m => m.OwnerId == Owner).OrderBy(m => m.DisplayOrder).ToListAsync();
        var shares = await MemberIncome.SharesAsync(db, Owner, 2026, 7, members, CancellationToken.None);
        alexItem.Income.Should().Be(shares.Income[alex.Id]).And.Be(3050m);
        robinItem.Income.Should().Be(shares.Income[robin.Id]).And.Be(50m);
        alexItem.SharePct.Should().Be(shares.ShareOf(alex.Id));
        robinItem.SharePct.Should().Be(shares.ShareOf(robin.Id));
        (alexItem.SharePct + robinItem.SharePct).Should().BeApproximately(1m, 0.0001m);
    }

    // ---- GetMemberSpending ----------------------------------------------------------------

    [Fact]
    public async Task GetMemberSpending_WithAMonth_CountsOnlyThatMonth_ConvertsByRate_AndSkipsFxPendingRows()
    {
        await using var db = NewContext();
        var alex = await SeedMember(db, "Alex", 0m, 0);
        var robin = await SeedMember(db, "Robin", 0m, 1);

        await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 6, 3), 100m, alex.Id, Gbp, rate: 1.2m); // 120
        await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 6, 4), 30m, alex.Id);                 // 30
        await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 5, 30), 500m, alex.Id);               // May: out of the month
        await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 6, 5), 77m, alex.Id, Gbp, rate: 1m, fxPending: true); // pending
        // A GBP split in June: Robin's slice converts; a pending split counts once per slice.
        var split = await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 6, 6), 20m, null, Gbp, rate: 1.2m);
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, MemberId = robin.Id, Amount = 20m });
        var pendingSplit = await AddTransaction(db, TransactionType.Expense, new DateOnly(2026, 6, 7), 40m, null, Gbp, rate: 1m, fxPending: true);
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = pendingSplit.Id, MemberId = robin.Id, Amount = 40m });
        await db.SaveChangesAsync();

        var handler = new GetMemberSpendingQueryHandler(db, User);

        var june = await handler.Handle(new GetMemberSpendingQuery(2026, 6), CancellationToken.None);
        var alexJune = june.Single(m => m.MemberId == alex.Id);
        alexJune.Spent.Should().Be(150m, "120 + 30; May is out of the month and the pending row is not summed");
        alexJune.FxPendingCount.Should().Be(1);
        var robinJune = june.Single(m => m.MemberId == robin.Id);
        robinJune.Spent.Should().Be(24m, "20 GBP slice × 1.2");
        robinJune.FxPendingCount.Should().Be(1);

        // Without a month the lens still sums all time (converted, pending still left out).
        var allTime = await handler.Handle(new GetMemberSpendingQuery(), CancellationToken.None);
        allTime.Single(m => m.MemberId == alex.Id).Spent.Should().Be(650m);
        allTime.Single(m => m.MemberId == alex.Id).FxPendingCount.Should().Be(1);
        allTime.Single(m => m.MemberId == robin.Id).Spent.Should().Be(24m);
    }

    // ---- Create / Update / Archive return the current month's share ------------------------

    [Fact]
    public async Task CreateUpdateArchive_ReturnIncomeShare_FromTheCurrentMonthsBudget()
    {
        await using var db = NewContext();
        var (year, month) = (DateTime.UtcNow.Year, DateTime.UtcNow.Month);
        var income = await SeedMonth(db, year, month);

        // Create: the month has a budget but no line for the new person yet → share 0.
        var created = await new CreateHouseholdMemberCommandHandler(db, User)
            .Handle(new CreateHouseholdMemberCommand("Alex", 9999m, null), CancellationToken.None);
        created.HasBudget.Should().BeTrue();
        (created.IncomeYear, created.IncomeMonth).Should().Be((year, month));
        created.NetMonthlyIncome.Should().Be(9999m);
        created.BudgetIncome.Should().Be(0m, "the saved default is not income");
        created.IncomeSharePct.Should().Be(0m);

        // Attribute a line to Alex; an update now reports the whole month as hers.
        await AddIncomeLine(db, income, "Alex — Salary", 3000m, created.Id);
        var updated = await new UpdateHouseholdMemberCommandHandler(db, User)
            .Handle(new UpdateHouseholdMemberCommand(created.Id, "Alex", 1m, null), CancellationToken.None);
        updated.BudgetIncome.Should().Be(3000m);
        updated.IncomeSharePct.Should().Be(1m);

        // A second person with a 1,000 line: 75 / 25.
        var robin = await new CreateHouseholdMemberCommandHandler(db, User)
            .Handle(new CreateHouseholdMemberCommand("Robin", 0m, null), CancellationToken.None);
        await AddIncomeLine(db, income, "Robin — Salary", 1000m, robin.Id);
        var robinUpdated = await new UpdateHouseholdMemberCommandHandler(db, User)
            .Handle(new UpdateHouseholdMemberCommand(robin.Id, "Robin", 0m, null), CancellationToken.None);
        robinUpdated.BudgetIncome.Should().Be(1000m);
        robinUpdated.IncomeSharePct.Should().Be(0.25m);

        // Archive Robin: the returned DTO holds no income; her line is now the household's, so
        // Alex's share is 100% of 4,000.
        var archived = await new ArchiveHouseholdMemberCommandHandler(db, User)
            .Handle(new ArchiveHouseholdMemberCommand(robin.Id), CancellationToken.None);
        archived.IsArchived.Should().BeTrue();
        archived.BudgetIncome.Should().Be(0m);
        archived.IncomeSharePct.Should().Be(0m);

        var active = await Members(db, year, month);
        active.Should().ContainSingle().Which.BudgetIncome.Should().Be(4000m);
        active.Single().IncomeSharePct.Should().Be(1m);
    }
}
