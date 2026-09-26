using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Queries.GetJarLedger;
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
}
