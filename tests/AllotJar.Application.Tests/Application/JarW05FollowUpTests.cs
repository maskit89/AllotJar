using System.Reflection;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The findings the PR #275 (W05) reviews left for a follow-up (P2-15 is pinned in
/// <c>JarMonthViewW05Tests</c>, beside the case it completes): restoring a jar keeps
/// the months it spent archived (P2-19); moving a jar into an account leaves that account's earlier
/// payments on the jar's line where they were (P2-20); an out-of-range month is a 400, not a 500
/// (P3-5); one read of the jars loads the ledger once, and a jar write a bounded number of times
/// (P3-6, P3-10); a move made before departures were recorded is settled at startup (P3-8); two
/// writers settling the same departure cannot overwrite each other (P3-9).
/// </summary>
public class JarW05FollowUpTests
{
    private const string Owner = "user-1";

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new(Owner);
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static DateOnly Deadline => new(Today.Year + 1, 7, 1);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-w05-follow-up-{Guid.NewGuid()}")
            .Options);

    private static Jar SeedGoal(ApplicationDbContext db, Account account, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m, TargetDate = Deadline,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>A budget month with a Savings line per jar given (planned amounts as given).</summary>
    private static IReadOnlyList<BudgetItem> SeedMonth(ApplicationDbContext db, DateOnly month, params (Jar Jar, decimal Planned)[] lines)
    {
        var items = lines.Select(l => new BudgetItem { Name = l.Jar.Name, PlannedAmount = l.Planned, SavingsId = l.Jar.Id }).ToList();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = items } },
        });
        db.SaveChanges();
        return items;
    }

    private static Task<IReadOnlyList<JarDto>> ReadAsync(IApplicationDbContext db, DateOnly? month, DateOnly? asOf = null) =>
        new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(AsOf: asOf, Month: month), Ct);

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Guid jarId, DateOnly asOf) =>
        (await JarLedgerReader.ReadAsync(db, Owner, asOf, Ct)).BalanceOf(jarId);

    private static UpdateJarCommand MoveTo(Jar jar, Guid accountId) =>
        new(jar.Id, jar.Name, JarKind.Goal, 1200m, Deadline, AccrualMethod.TargetByDate, accountId);

    // ---- P2-19 -------------------------------------------------------------------------------

    [Fact]
    public async Task P2_19_RestoringAJar_KeepsTheMonthsItSpentArchived()
    {
        // Insurance, 300 due 15 Aug; 100 went in on 1 Jul and came out on 20 Jul, when the jar was
        // archived. August has no line for it: while archived, August lists no jar.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m);
        var bill = new Jar
        {
            OwnerId = Owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 300m,
            TargetDate = new DateOnly(2026, 8, 15), CycleDeadline = new DateOnly(2026, 8, 15), RecurMonths = 12,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
            IsArchived = true, ArchivedOn = new DateOnly(2026, 7, 20),
        };
        db.Jars.Add(bill);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, 100m, new DateOnly(2026, 7, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, bill.Id, -100m, new DateOnly(2026, 7, 20), JarAllocationKind.Reallocation);
        SeedMonth(db, new DateOnly(2026, 7, 1), (bill, 100m));
        SeedMonth(db, new DateOnly(2026, 8, 1));
        var august = new DateOnly(2026, 8, 1);
        (await ReadAsync(db, august)).Should().BeEmpty();

        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(bill.Id, Archived: false), Ct);

        // August is over and the jar was archived all through it: restoring it today rewrites nothing.
        (await ReadAsync(db, august)).Should().BeEmpty();
        // July (its line, archived on the 20th) still reads the jar as archived at the month's end.
        var july = (await ReadAsync(db, new DateOnly(2026, 7, 1))).Single();
        july.Status.Should().NotBe("DeadlineMissed");
        // The archive period is kept, so a second archive and restore keeps both.
        var periods = await db.JarArchivePeriods.Where(p => p.JarId == bill.Id).ToListAsync();
        periods.Should().ContainSingle().Which.Should().Match<JarArchivePeriod>(p =>
            p.ArchivedOn == new DateOnly(2026, 7, 20) && p.RestoredOn == Today);
        // The current month reads it live again.
        (await ReadAsync(db, null)).Should().ContainSingle(j => j.Id == bill.Id);
    }

    [Fact]
    public void P2_19_IsArchivedOn_ReadsTheArchivePeriods()
    {
        var jar = new Jar { IsArchived = false, ArchivedOn = null };
        var periods = new[] { new JarArchivePeriod { ArchivedOn = new DateOnly(2026, 7, 20), RestoredOn = new DateOnly(2026, 9, 29) } };

        var july = JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 7, 31));
        july.IsArchived.Should().BeTrue();
        july.ArchivedOn.Should().Be(new DateOnly(2026, 7, 20));
        JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 7, 19)).IsArchived.Should().BeFalse();
        // The restore day is live again.
        JarHistory.ArchiveOn(jar, periods, new DateOnly(2026, 9, 29)).IsArchived.Should().BeFalse();
    }

    // ---- P2-20 -------------------------------------------------------------------------------

    [Fact]
    public async Task P2_20_MovingAJarIntoAnAccount_LeavesThatAccountsEarlierLinePaymentsWhereTheyWere()
    {
        // Holiday is in A and holds 0; on 20 Aug a 50 payment from B went on Holiday's August line,
        // so it drew from B's unallocated money. Moving Holiday to B must not pull it onto the jar.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 100m)).Single();
        var old = LedgerFixtures.Expense(db, Owner, b.Id, 50m, new DateOnly(2026, 8, 20), line.Id);

        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 25))).Should().Be(0m);
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).Accounts[b.Id].Unallocated.Should().Be(950m);
        // A payee edit of the old payment keeps it on B's unallocated money.
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(old.Id, old.Date, "Travel agent", 50m, TransactionType.Expense, b.Id), Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        // Nothing is stuck: the jar can be archived.
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
    }

    [Fact]
    public async Task P2_20_APaymentOnTheJarsLineFromItsNewAccount_DrawsFromTheJarFromTheDayAfterTheMove()
    {
        // The move day belongs to the account the jar left, as its departure does: a payment from
        // the new account dated that day stays on its unallocated money, one dated later draws
        // from the jar, and a later edit re-derives it the same way.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        var line = SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m)).Single();

        await new UpdateJarCommandHandler(db, User).Handle(MoveTo(jar, b.Id), Ct);
        LedgerFixtures.Allocate(db, Owner, b.Id, jar.Id, 100m, Today);
        LedgerFixtures.Expense(db, Owner, b.Id, 30m, Today, line.Id);
        var later = LedgerFixtures.Expense(db, Owner, b.Id, 20m, Today.AddDays(1), line.Id);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, Today.AddDays(1))).Should().Be(80m);
        (await db.Jars.SingleAsync(j => j.Id == jar.Id)).FundingAccountSince.Should().Be(Today);
        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(later.Id, Today, "Shop", 20m, TransactionType.Expense, b.Id), Ct);
        (await BalanceAsync(db, jar.Id, Today.AddDays(1))).Should().Be(100m);
    }

    // ---- P3-5 --------------------------------------------------------------------------------

    [Theory]
    [InlineData(9999, 12, null)]
    [InlineData(1, 1, null)]
    [InlineData(null, null, "9999-12-31")]
    [InlineData(null, null, "0001-01-01")]
    public void P3_5_AMonthOrDateOutsideTheBudgetRange_IsAValidationError(int? year, int? month, string? asOf)
    {
        var query = new GetJarsQuery(
            AsOf: asOf is null ? null : DateOnly.Parse(asOf),
            Month: year is { } y ? new DateOnly(y, month!.Value, 1) : null);

        new GetJarsQueryValidator().Validate(query).IsValid.Should().BeFalse();
    }

    [Fact]
    public void P3_5_AnOrdinaryMonth_IsValid() =>
        new GetJarsQueryValidator().Validate(new GetJarsQuery(AsOf: new DateOnly(2026, 10, 10), Month: new DateOnly(2026, 9, 1))).IsValid.Should().BeTrue();

    // ---- P3-6 / P3-10 ------------------------------------------------------------------------

    /// <summary>Counts every <see cref="IApplicationDbContext"/> member read, to count ledger loads (one read of <c>Accounts</c> per load).</summary>
    public class CountingContext : DispatchProxy
    {
        public IApplicationDbContext Inner { get; set; } = null!;
        public Dictionary<string, int> Counts { get; } = new();

        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        {
            var name = targetMethod!.Name;
            Counts[name] = Counts.GetValueOrDefault(name) + 1;
            try
            {
                return targetMethod.Invoke(Inner, args);
            }
            catch (TargetInvocationException ex) when (ex.InnerException is not null)
            {
                throw ex.InnerException;
            }
        }

        public static (IApplicationDbContext Db, CountingContext Counter) Wrap(IApplicationDbContext inner)
        {
            var proxy = Create<IApplicationDbContext, CountingContext>();
            var counter = (CountingContext)(object)proxy;
            counter.Inner = inner;
            return (proxy, counter);
        }

        public int LedgerLoads => Counts.GetValueOrDefault("get_Accounts");
    }

    [Fact]
    public async Task P3_6_OneReadOfAPastMonthsJars_LoadsTheLedgerOnce()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 200m, new DateOnly(2026, 8, 20));
        var (counting, counter) = CountingContext.Wrap(db);

        var september = (await ReadAsync(counting, new DateOnly(2026, 9, 1), new DateOnly(2026, 10, 10))).Single();

        september.CurrentBalance.Should().Be(200m);
        counter.LedgerLoads.Should().Be(1);
    }

    [Fact]
    public async Task P3_10_AJarEdit_LoadsTheLedgerOnceBeforeAndOnceAfterTheSave()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedMonth(db, new DateOnly(Today.Year, Today.Month, 1), (jar, 100m));
        var (counting, counter) = CountingContext.Wrap(db);

        // A new target: the replant reads the ledger as it was before the edit, the card after it.
        var card = await new UpdateJarCommandHandler(counting, User).Handle(
            new UpdateJarCommand(jar.Id, jar.Name, JarKind.Goal, 2400m, Deadline, AccrualMethod.TargetByDate, account.Id), Ct);

        card.TargetAmount.Should().Be(2400m);
        counter.LedgerLoads.Should().Be(2);
    }

    // ---- P3-8 --------------------------------------------------------------------------------

    [Fact]
    public async Task P3_8_AMoveMadeBeforeDeparturesWereRecorded_IsSettledByTheBackfill_Once()
    {
        // Holiday held 100 in A and paid 100 from its line on 20 Aug; it moved to B on main (no
        // departure), and main's edit then corrected the kept payment to 80 without settling: A's
        // ledger holds 20 of Holiday, which blocked its archive until a kept entry was edited.
        await using var db = NewContext();
        var a = LedgerFixtures.SeedAccount(db, Owner, "A", opening: 1000m);
        var b = LedgerFixtures.SeedAccount(db, Owner, "B", opening: 1000m, order: 1);
        var jar = SeedGoal(db, a);
        LedgerFixtures.Allocate(db, Owner, a.Id, jar.Id, 100m, new DateOnly(2026, 8, 1));
        var line = SeedMonth(db, new DateOnly(2026, 8, 1), (jar, 100m)).Single();
        var payment = LedgerFixtures.Expense(db, Owner, a.Id, 100m, new DateOnly(2026, 8, 20), line.Id);
        await JarMovements.KeepLineAttributionAsync(db, Owner, jar, new DateOnly(2026, 9, 1), Ct);
        jar.FundingAccountId = b.Id;
        await db.SaveChangesAsync(Ct);
        var op = await db.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.TransactionId == payment.Id);
        op.Postings.Single(p => p.JarId == jar.Id).Amount = -80m;
        payment.Amount = 80m;
        await db.SaveChangesAsync(Ct);
        (await BalanceAsync(db, jar.Id, Today)).Should().Be(20m);

        (await JarDepartures.BackfillAsync(db, Ct)).Should().Be(1);

        (await BalanceAsync(db, jar.Id, Today)).Should().Be(0m);
        // Dated on the last day A's ledger touched the jar: the history before it is unchanged.
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 19))).Should().Be(100m);
        (await BalanceAsync(db, jar.Id, new DateOnly(2026, 8, 20))).Should().Be(0m);
        (await JarDepartures.BackfillAsync(db, Ct)).Should().Be(0);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(jar.Id), Ct);
    }

    // ---- P3-9 --------------------------------------------------------------------------------

    [Fact]
    public async Task P3_9_TwoWritersSettlingTheSameDeparture_TheSecondIsRefused_NotLost()
    {
        // Two requests load the same departure and each shifts it for its own kept leg; without a
        // lock or a token the second save overwrites the first, and the old account holds a
        // residue of the jar again.
        var name = $"zbb-w05-follow-up-{Guid.NewGuid()}";
        ApplicationDbContext Open() => new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase(name).Options);
        Guid departureId;
        await using (var seed = Open())
        {
            var a = LedgerFixtures.SeedAccount(seed, Owner, "A");
            var b = LedgerFixtures.SeedAccount(seed, Owner, "B", order: 1);
            var jar = SeedGoal(seed, b);
            var departure = LedgerFixtures.Allocate(seed, Owner, a.Id, jar.Id, 0m, new DateOnly(2026, 9, 1), JarAllocationKind.Departure);
            departureId = departure.Id;
        }

        await using var first = Open();
        await using var second = Open();
        var one = await first.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Id == departureId);
        var two = await second.JarAllocations.Include(x => x.Postings).SingleAsync(x => x.Id == departureId);
        foreach (var posting in one.Postings) posting.Amount += posting.JarId is null ? -20m : 20m;
        foreach (var posting in two.Postings) posting.Amount += posting.JarId is null ? -30m : 30m;
        await first.SaveChangesAsync(Ct);

        var lost = () => second.SaveChangesAsync(Ct);

        await lost.Should().ThrowAsync<DbUpdateConcurrencyException>();
    }
}
