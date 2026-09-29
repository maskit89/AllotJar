using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Jars.Queries.GetJarLedger;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Relational guarantees of the jar ledger that EF InMemory cannot see (rules 2, 8, 68, 73):
/// the Restrict foreign key from a jar to its designated account, the cascade from an
/// allocation (and its transaction) to its postings, the unique filtered
/// (TransactionId, AccountId) index that stops one account leg being attributed twice, and the
/// per-account ledger lock (<see cref="IApplicationDbContext.BeginLedgerWriteAsync"/>) that
/// serialises two reallocations so the second validates against the committed money.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class JarLedgerSqlTests
{
    private readonly SqlServerFixture _fixture;

    public JarLedgerSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static async Task<Account> SeedAccountAsync(ApplicationDbContext db, string owner, decimal opening = 1000m)
    {
        var account = new Account
        {
            OwnerId = owner, Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
    }

    private static async Task<Jar> SeedJarAsync(ApplicationDbContext db, Account account, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = account.OwnerId, Name = name, Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        return jar;
    }

    private static JarAllocation Allocation(
        string owner, Guid accountId, Guid? jarId, decimal amount, Guid? transactionId = null,
        JarAllocationKind kind = JarAllocationKind.InitialAllocation) => new()
    {
        OwnerId = owner, AccountId = accountId, Kind = kind, Date = new DateOnly(2026, 6, 1),
        TransactionId = transactionId, CreatedUtc = DateTime.UtcNow,
        Postings = transactionId is null
            ? new List<JarAllocationPosting>
            {
                new() { JarId = jarId, Amount = amount },
                new() { JarId = null, Amount = -amount },
            }
            : new List<JarAllocationPosting> { new() { JarId = jarId, Amount = amount } },
    };

    [Fact]
    public async Task Database_refuses_to_delete_an_account_that_backs_a_jar()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        await SeedJarAsync(db, account);

        // Delete from a context that has not loaded the jar, so EF's client-side required-
        // relationship check cannot pre-empt the database: the constraint itself must refuse.
        await using var deleter = _fixture.CreateContext();
        deleter.Accounts.Remove(new Account { Id = account.Id });
        var act = () => deleter.SaveChangesAsync();

        // FK_Jars_Accounts_FundingAccountId is Restrict: the jar's money would be orphaned.
        await act.Should().ThrowAsync<DbUpdateException>();

        await using var verify = _fixture.CreateContext();
        (await verify.Accounts.AnyAsync(a => a.Id == account.Id)).Should().BeTrue();
        (await verify.Jars.CountAsync(j => j.OwnerId == owner)).Should().Be(1);
    }

    [Fact]
    public async Task Database_refuses_a_jar_without_a_real_account()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();

        db.Jars.Add(new Jar { OwnerId = owner, Name = "Orphan", FundingAccountId = Guid.NewGuid() });
        var act = () => db.SaveChangesAsync();

        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Deleting_an_allocation_cascades_to_its_postings()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        var jar = await SeedJarAsync(db, account);
        var allocation = Allocation(owner, account.Id, jar.Id, 300m);
        db.JarAllocations.Add(allocation);
        await db.SaveChangesAsync();

        await using (var verify = _fixture.CreateContext())
        {
            (await verify.JarAllocationPostings.CountAsync(p => p.JarAllocationId == allocation.Id)).Should().Be(2);
        }

        await using (var remove = _fixture.CreateContext())
        {
            remove.JarAllocations.Remove(new JarAllocation { Id = allocation.Id });
            await remove.SaveChangesAsync();
        }

        await using (var verify = _fixture.CreateContext())
        {
            (await verify.JarAllocations.AnyAsync(a => a.Id == allocation.Id)).Should().BeFalse();
            (await verify.JarAllocationPostings.AnyAsync(p => p.JarAllocationId == allocation.Id)).Should().BeFalse();
            // The jar itself is untouched (postings → jar is Restrict, never a cascade into Jars).
            (await verify.Jars.AnyAsync(j => j.Id == jar.Id)).Should().BeTrue();
        }
    }

    [Fact]
    public async Task Deleting_a_transaction_cascades_to_its_allocation_and_postings()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        var jar = await SeedJarAsync(db, account);
        var deposit = new Transaction
        {
            OwnerId = owner, AccountId = account.Id, Type = TransactionType.Income, Amount = 100m,
            Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 6, 1), Payee = "Employer",
        };
        db.Transactions.Add(deposit);
        await db.SaveChangesAsync();
        var allocation = Allocation(owner, account.Id, jar.Id, 100m, deposit.Id, JarAllocationKind.Movement);
        db.JarAllocations.Add(allocation);
        await db.SaveChangesAsync();

        await using (var remove = _fixture.CreateContext())
        {
            remove.Transactions.Remove(new Transaction { Id = deposit.Id });
            await remove.SaveChangesAsync();
        }

        await using var verify = _fixture.CreateContext();
        (await verify.JarAllocations.AnyAsync(a => a.Id == allocation.Id)).Should().BeFalse();
        (await verify.JarAllocationPostings.AnyAsync(p => p.JarAllocationId == allocation.Id)).Should().BeFalse();
    }

    [Fact]
    public async Task Database_refuses_a_second_attribution_of_the_same_account_leg()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        var jar = await SeedJarAsync(db, account);
        var deposit = new Transaction
        {
            OwnerId = owner, AccountId = account.Id, Type = TransactionType.Income, Amount = 100m,
            Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 6, 1), Payee = "Employer",
        };
        db.Transactions.Add(deposit);
        await db.SaveChangesAsync();
        db.JarAllocations.Add(Allocation(owner, account.Id, jar.Id, 100m, deposit.Id, JarAllocationKind.Movement));
        await db.SaveChangesAsync();

        await using var second = _fixture.CreateContext();
        second.JarAllocations.Add(Allocation(owner, account.Id, null, 100m, deposit.Id, JarAllocationKind.Movement));
        var act = () => second.SaveChangesAsync();

        // IX_JarAllocations_TransactionId_AccountId (filtered on TransactionId IS NOT NULL).
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task The_unique_index_ignores_zero_sum_operations_with_no_transaction()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        var jar = await SeedJarAsync(db, account);

        // Several transaction-less operations on one account are ordinary (initial allocation,
        // then reallocations): the filter keeps them outside the uniqueness.
        db.JarAllocations.Add(Allocation(owner, account.Id, jar.Id, 100m));
        db.JarAllocations.Add(Allocation(owner, account.Id, jar.Id, 50m, kind: JarAllocationKind.Reallocation));
        db.JarAllocations.Add(Allocation(owner, account.Id, jar.Id, -30m, kind: JarAllocationKind.Reallocation));
        await db.SaveChangesAsync();

        await using var verify = _fixture.CreateContext();
        (await verify.JarAllocations.CountAsync(a => a.OwnerId == owner)).Should().Be(3);
    }

    [Fact]
    public async Task Concurrent_reallocations_are_serialised_so_only_one_can_take_the_jars_money()
    {
        // Holiday holds 100. Two users each move 80 to Repairs at the same moment on separate
        // connections. The per-account ledger lock makes the second wait for the first commit and
        // then validate against the committed 20 (rule 68): exactly one succeeds, the other is a
        // ValidationException (never a corrupt −60 jar), and Holiday ends at 20.
        var owner = NewOwner();
        Account account;
        Jar holiday;
        Jar repairs;
        await using (var seed = _fixture.CreateContext())
        {
            account = await SeedAccountAsync(seed, owner, opening: 500m);
            holiday = await SeedJarAsync(seed, account, "Holiday");
            repairs = await SeedJarAsync(seed, account, "Repairs");
            seed.JarAllocations.Add(Allocation(owner, account.Id, holiday.Id, 100m));
            await seed.SaveChangesAsync();
        }

        async Task<Exception?> TryMove()
        {
            await using var db = _fixture.CreateContext();
            var handler = new ReallocateJarMoneyCommandHandler(db, new CurrentUserStub(owner));
            try
            {
                await handler.Handle(
                    new ReallocateJarMoneyCommand(account.Id, holiday.Id, repairs.Id, 80m), CancellationToken.None);
                return null;
            }
            catch (Exception ex)
            {
                return ex;
            }
        }

        var results = await Task.WhenAll(TryMove(), TryMove());

        var failures = results.Where(r => r is not null).ToList();
        failures.Should().ContainSingle("exactly one of the two racing moves must be refused");
        failures[0].Should().BeOfType<ValidationException>(
            "the loser must surface as a friendly 400 from the rule 68 check, not a raw 500");

        await using var verify = _fixture.CreateContext();
        (await verify.JarAllocations.CountAsync(a => a.OwnerId == owner && a.Kind == JarAllocationKind.Reallocation))
            .Should().Be(1);
        var ledger = (await new GetJarLedgerQueryHandler(verify, new CurrentUserStub(owner))
                .Handle(new GetJarLedgerQuery(null, account.Id), CancellationToken.None))
            .Single();
        ledger.AccountBalance.Should().Be(500m);
        ledger.Jars.Single(j => j.JarId == holiday.Id).Balance.Should().Be(20m);
        ledger.Jars.Single(j => j.JarId == repairs.Id).Balance.Should().Be(80m);
        ledger.Unallocated.Should().Be(400m);
        ledger.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task A_jar_edit_is_dated_so_last_month_keeps_the_target_it_had()
    {
        // P49 on SQL Server: the first edit stores the definition it replaces from 0001-01-01
        // (the date column's minimum) and the new one from today; a second edit today updates
        // today's row under the unique (JarId, EffectiveFrom) index. Last month still reads 1000.
        var owner = NewOwner();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var current = new DateOnly(today.Year, today.Month, 1);
        Account account;
        Jar jar;
        await using (var seed = _fixture.CreateContext())
        {
            account = await SeedAccountAsync(seed, owner);
            jar = await SeedJarAsync(seed, account);
            seed.JarAllocations.Add(Allocation(owner, account.Id, jar.Id, 600m));
            await seed.SaveChangesAsync();
        }

        foreach (var target in new[] { 600m, 700m })
        {
            await using var db = _fixture.CreateContext();
            await new UpdateJarCommandHandler(db, new CurrentUserStub(owner)).Handle(
                new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, target, current.AddMonths(10), AccrualMethod.TargetByDate, account.Id),
                CancellationToken.None);
        }

        await using var verify = _fixture.CreateContext();
        (await verify.JarRevisions.Where(r => r.JarId == jar.Id).OrderBy(r => r.EffectiveFrom)
                .Select(r => new { r.EffectiveFrom, r.TargetAmount }).ToListAsync())
            .Should().Equal(new { EffectiveFrom = DateOnly.MinValue, TargetAmount = 1000m }, new { EffectiveFrom = today, TargetAmount = 700m });
        var reads = new GetJarsQueryHandler(verify, new CurrentUserStub(owner));
        (await reads.Handle(new GetJarsQuery(Month: current.AddMonths(-1)), CancellationToken.None)).Single().TargetAmount.Should().Be(1000m);
        (await reads.Handle(new GetJarsQuery(Month: current), CancellationToken.None)).Single().TargetAmount.Should().Be(700m);
    }

    [Fact]
    public async Task A_correction_to_a_kept_payment_is_settled_on_the_day_the_jar_left()
    {
        // P51 on SQL Server: Holiday held 100 in A and its June line paid 100 from A; it moves to B
        // today. Correcting that payment to 80 leaves 20 in A's history, which the Departure
        // operation dated today returns to A's unallocated money, so A holds nothing of the jar.
        var owner = NewOwner();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var june20 = new DateOnly(2026, 6, 20);
        Account a, b;
        Jar jar;
        Transaction payment;
        await using (var seed = _fixture.CreateContext())
        {
            a = await SeedAccountAsync(seed, owner);
            b = await SeedAccountAsync(seed, owner);
            jar = await SeedJarAsync(seed, a);
            seed.JarAllocations.Add(Allocation(owner, a.Id, jar.Id, 100m));
            var line = new BudgetItem { Name = "Holiday", SavingsId = jar.Id, PlannedAmount = 100m };
            seed.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = owner, Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
            });
            await seed.SaveChangesAsync();
            payment = new Transaction
            {
                OwnerId = owner, AccountId = a.Id, BudgetItemId = line.Id, Amount = 100m, Currency = CurrencyCode.Eur,
                Type = TransactionType.Expense, Date = june20, Payee = "Travel agent",
            };
            seed.Transactions.Add(payment);
            await seed.SaveChangesAsync();
        }

        await using (var move = _fixture.CreateContext())
        {
            await new UpdateJarCommandHandler(move, new CurrentUserStub(owner)).Handle(
                new UpdateJarCommand(jar.Id, "Holiday", JarKind.Goal, 1000m, null, AccrualMethod.TargetByDate, b.Id), CancellationToken.None);
        }
        await using (var correct = _fixture.CreateContext())
        {
            await new UpdateTransactionCommandHandler(correct, new CurrentUserStub(owner)).Handle(
                new UpdateTransactionCommand(payment.Id, june20, "Travel agent", 80m, TransactionType.Expense, a.Id), CancellationToken.None);
        }

        await using var verify = _fixture.CreateContext();
        var departure = await verify.JarAllocations.AsNoTracking().Include(al => al.Postings)
            .SingleAsync(al => al.AccountId == a.Id && al.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(today);
        departure.Postings.Select(p => (p.JarId, p.Amount)).Should().BeEquivalentTo(new (Guid?, decimal)[] { (jar.Id, -20m), (null, 20m) });
        var ledger = (await new GetJarLedgerQueryHandler(verify, new CurrentUserStub(owner)).Handle(new GetJarLedgerQuery(null, a.Id), CancellationToken.None)).Single();
        (ledger.Jars.SingleOrDefault(j => j.JarId == jar.Id)?.Balance ?? 0m).Should().Be(0m);
        ledger.Unallocated.Should().Be(920m);
        (await new GetJarsQueryHandler(verify, new CurrentUserStub(owner)).Handle(new GetJarsQuery(), CancellationToken.None))
            .Single().CurrentBalance.Should().Be(0m);
    }

    [Fact]
    public async Task A_move_made_before_departures_were_recorded_is_backfilled_once()
    {
        // P3-8 on SQL Server (the backfill's query runs across owners): Holiday held 100 in A,
        // 80 of it was spent, and it was re-designated to B with no departure, as the old code
        // did. The backfill records one departure of 20, dated on A's last posting of the jar.
        var owner = NewOwner();
        Account a;
        Jar jar;
        await using (var seed = _fixture.CreateContext())
        {
            a = await SeedAccountAsync(seed, owner);
            var b = await SeedAccountAsync(seed, owner);
            jar = await SeedJarAsync(seed, a);
            seed.JarAllocations.Add(Allocation(owner, a.Id, jar.Id, 100m));
            var spent = Allocation(owner, a.Id, jar.Id, -80m, kind: JarAllocationKind.Reallocation);
            spent.Date = new DateOnly(2026, 6, 20);
            seed.JarAllocations.Add(spent);
            await seed.SaveChangesAsync();
            jar.FundingAccountId = b.Id;
            await seed.SaveChangesAsync();
        }

        await using (var first = _fixture.CreateContext())
        {
            await AllotJar.Application.Jars.JarDepartures.BackfillAsync(first, CancellationToken.None);
        }
        await using (var second = _fixture.CreateContext())
        {
            await AllotJar.Application.Jars.JarDepartures.BackfillAsync(second, CancellationToken.None);
        }

        await using var verify = _fixture.CreateContext();
        var departure = await verify.JarAllocations.AsNoTracking().Include(al => al.Postings)
            .SingleAsync(al => al.AccountId == a.Id && al.Kind == JarAllocationKind.Departure);
        departure.Date.Should().Be(new DateOnly(2026, 6, 20));
        departure.Postings.Select(p => (p.JarId, p.Amount)).Should().BeEquivalentTo(new (Guid?, decimal)[] { (jar.Id, -20m), (null, 20m) });
        (await new GetJarsQueryHandler(verify, new CurrentUserStub(owner)).Handle(new GetJarsQuery(), CancellationToken.None))
            .Single().CurrentBalance.Should().Be(0m);
    }

    [Fact]
    public async Task Two_writers_shifting_the_same_departure_the_second_is_refused_not_lost()
    {
        // P3-9 on SQL Server: the posting's amount is the concurrency token, so a writer that read
        // the departure before another one shifted it fails instead of overwriting that shift.
        var owner = NewOwner();
        Guid departureId;
        await using (var seed = _fixture.CreateContext())
        {
            var a = await SeedAccountAsync(seed, owner);
            var b = await SeedAccountAsync(seed, owner);
            var jar = await SeedJarAsync(seed, b);
            var departure = Allocation(owner, a.Id, jar.Id, 0m, kind: JarAllocationKind.Departure);
            seed.JarAllocations.Add(departure);
            await seed.SaveChangesAsync();
            departureId = departure.Id;
        }

        await using var one = _fixture.CreateContext();
        await using var two = _fixture.CreateContext();
        var first = await one.JarAllocations.Include(al => al.Postings).SingleAsync(al => al.Id == departureId);
        var second = await two.JarAllocations.Include(al => al.Postings).SingleAsync(al => al.Id == departureId);
        foreach (var posting in first.Postings) posting.Amount += posting.JarId is null ? -20m : 20m;
        foreach (var posting in second.Postings) posting.Amount += posting.JarId is null ? -30m : 30m;
        await one.SaveChangesAsync();

        var lost = () => two.SaveChangesAsync();

        await lost.Should().ThrowAsync<DbUpdateConcurrencyException>();
        await using var verify = _fixture.CreateContext();
        (await verify.JarAllocationPostings.AsNoTracking().Where(p => p.JarAllocationId == departureId && p.JarId != null).SingleAsync())
            .Amount.Should().Be(20m);
    }

    [Fact]
    public async Task Restoring_a_jar_stores_the_stretch_it_spent_archived()
    {
        // P2-19 on SQL Server: the JarArchivePeriods table and its foreign key.
        var owner = NewOwner();
        Jar jar;
        await using (var seed = _fixture.CreateContext())
        {
            var a = await SeedAccountAsync(seed, owner);
            jar = await SeedJarAsync(seed, a);
            jar.IsArchived = true;
            jar.ArchivedOn = new DateOnly(2026, 6, 1);
            await seed.SaveChangesAsync();
        }

        await using (var restore = _fixture.CreateContext())
        {
            await new AllotJar.Application.Jars.Commands.ArchiveJar.ArchiveJarCommandHandler(restore, new CurrentUserStub(owner))
                .Handle(new AllotJar.Application.Jars.Commands.ArchiveJar.ArchiveJarCommand(jar.Id, Archived: false), CancellationToken.None);
        }

        await using var verify = _fixture.CreateContext();
        var period = await verify.JarArchivePeriods.AsNoTracking().SingleAsync(p => p.JarId == jar.Id);
        period.ArchivedOn.Should().Be(new DateOnly(2026, 6, 1));
        period.RestoredOn.Should().Be(DateOnly.FromDateTime(DateTime.UtcNow));
        (await verify.Jars.AsNoTracking().SingleAsync(j => j.Id == jar.Id)).ArchivedOn.Should().BeNull();
    }
}
