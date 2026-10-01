using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CompleteJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// HANDOVER P11 on SQL Server: every write that checks or posts to an account's money or jars
/// takes that account's ledger lock first (app-2026-09-30 review JL-P2-5, JL-P2-6, TX-P3-4,
/// MG-P2-1). Each test holds the lock on one connection as a racing writer would, runs the real
/// handler on another, checks it waits, lets the racing writer commit, and checks the handler
/// then judges the committed state.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class LedgerLockSqlTests(SqlServerFixture fixture)
{
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(2);
    private static readonly DateOnly Jan1 = new(2026, 1, 1);
    private static DateOnly Today => DateOnly.FromDateTime(DateTime.UtcNow);
    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private async Task<Account> SeedAccountAsync(string owner, string name, decimal opening, AccountType type = AccountType.Savings)
    {
        await using var db = fixture.CreateContext();
        var account = new Account
        {
            OwnerId = owner, Name = name, Type = type, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = Jan1,
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
    }

    private async Task<Jar> SeedJarAsync(Account account, string name, decimal initial = 0m)
    {
        await using var db = fixture.CreateContext();
        var jar = new Jar
        {
            OwnerId = account.OwnerId, Name = name, Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        if (initial != 0m)
        {
            db.JarAllocations.Add(Move(account, Jan1, (null, -initial), (jar.Id, initial), JarAllocationKind.InitialAllocation));
        }
        await db.SaveChangesAsync();
        return jar;
    }

    private static JarAllocation Move(Account account, DateOnly date, (Guid? Jar, decimal Amount) from, (Guid? Jar, decimal Amount) to,
        JarAllocationKind kind = JarAllocationKind.Reallocation) => new()
    {
        OwnerId = account.OwnerId, AccountId = account.Id, Kind = kind, Date = date, CreatedUtc = DateTime.UtcNow,
        Postings = { new() { JarId = from.Jar, Amount = from.Amount }, new() { JarId = to.Jar, Amount = to.Amount } },
    };

    private static Transaction Expense(Account account, decimal amount, DateOnly date) => new()
    {
        OwnerId = account.OwnerId, Date = date, Payee = "Garage", Amount = amount, Currency = CurrencyCode.Eur,
        Type = TransactionType.Expense, AccountId = account.Id,
    };

    /// <summary>
    /// Holds the ledger lock on <paramref name="locked"/> while <paramref name="command"/> runs on
    /// its own connection, checks the command is still waiting, writes <paramref name="racing"/>
    /// under the lock and commits. Returns what the command then threw, or null.
    /// </summary>
    private async Task<Exception?> RunAgainstHeldLockAsync(
        Guid[] locked, Func<ApplicationDbContext, Task> command, Func<ApplicationDbContext, Task>? racing = null)
    {
        await using var holder = fixture.CreateContext();
        var write = await holder.BeginLedgerWriteAsync(locked, Ct);
        write.Should().NotBeNull();
        var run = Task.Run(async () =>
        {
            await using var db = fixture.CreateContext();
            await command(db);
        });
        var first = await Task.WhenAny(run, Task.Delay(Wait));
        if (first == run)
        {
            await write!.DisposeAsync();
            await run; // surfaces what it threw
            throw new InvalidOperationException("The command finished while the ledger lock was held: it does not take the lock.");
        }
        if (racing is not null)
        {
            await racing(holder);
            await holder.SaveChangesAsync(Ct);
        }
        await write!.CommitAsync(Ct);
        await write.DisposeAsync();
        try
        {
            await run.WaitAsync(TimeSpan.FromSeconds(30));
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    private static string Errors(Exception? ex) =>
        ex is ValidationException v ? string.Join(" ", v.Errors.SelectMany(e => e.Value)) : ex?.ToString() ?? "(none)";

    [Fact]
    public async Task Archiving_a_jar_waits_for_a_reallocation_into_it_and_then_sees_its_money()
    {
        var owner = NewOwner();
        var savings = await SeedAccountAsync(owner, "Savings", 500m);
        var holiday = await SeedJarAsync(savings, "Holiday");
        var car = await SeedJarAsync(savings, "Car", 100m);

        var error = await RunAgainstHeldLockAsync(new[] { savings.Id },
            db => new ArchiveJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new ArchiveJarCommand(holiday.Id), Ct),
            racing: db =>
            {
                db.JarAllocations.Add(Move(savings, Today, (car.Id, -100m), (holiday.Id, 100m)));
                return Task.CompletedTask;
            });

        Errors(error).Should().Contain("Holiday still holds 100");
        await using var verify = fixture.CreateContext();
        (await verify.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task A_reallocation_into_a_jar_waits_for_its_archive_and_is_then_refused()
    {
        var owner = NewOwner();
        var savings = await SeedAccountAsync(owner, "Savings", 500m);
        var holiday = await SeedJarAsync(savings, "Holiday");
        var car = await SeedJarAsync(savings, "Car", 100m);

        var error = await RunAgainstHeldLockAsync(new[] { savings.Id },
            db => new ReallocateJarMoneyCommandHandler(db, new CurrentUserStub(owner))
                .Handle(new ReallocateJarMoneyCommand(savings.Id, car.Id, holiday.Id, 100m), Ct),
            racing: async db =>
            {
                var jar = await db.Jars.SingleAsync(j => j.Id == holiday.Id);
                jar.IsArchived = true;
                jar.ArchivedOn = Today;
            });

        Errors(error).Should().Contain("Holiday is archived");
        await using var verify = fixture.CreateContext();
        (await JarLedgerReader.ReadAsync(verify, owner, Today, Ct)).BalanceOf(holiday.Id).Should().Be(0m);
    }

    [Fact]
    public async Task Completing_a_jar_waits_for_the_accounts_ledger_lock()
    {
        var owner = NewOwner();
        var savings = await SeedAccountAsync(owner, "Savings", 500m);
        var holiday = await SeedJarAsync(savings, "Holiday", 100m);

        var error = await RunAgainstHeldLockAsync(new[] { savings.Id },
            db => new CompleteJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new CompleteJarCommand(holiday.Id), Ct),
            racing: db =>
            {
                db.JarAllocations.Add(Move(savings, Today, (holiday.Id, -150m), (null, 150m)));
                return Task.CompletedTask;
            });

        Errors(error).Should().Contain("Holiday is 50 overdrawn");
    }

    [Fact]
    public async Task Moving_a_jar_waits_for_a_reallocation_into_it_in_the_old_account()
    {
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Old savings", 500m);
        var b = await SeedAccountAsync(owner, "New savings", 0m);
        var holiday = await SeedJarAsync(a, "Holiday");

        var error = await RunAgainstHeldLockAsync(new[] { a.Id },
            db => new UpdateJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateJarCommand(
                holiday.Id, "Holiday", JarKind.Goal, 1000m, null, AccrualMethod.TargetByDate, b.Id), Ct),
            racing: db =>
            {
                db.JarAllocations.Add(Move(a, Today, (null, -100m), (holiday.Id, 100m)));
                return Task.CompletedTask;
            });

        Errors(error).Should().Contain("Holiday holds 100 in Old savings");
        await using var verify = fixture.CreateContext();
        (await verify.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).FundingAccountId.Should().Be(a.Id);
    }

    [Fact]
    public async Task Moving_a_jar_waits_for_the_ledger_lock_of_the_account_it_moves_to()
    {
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Old savings", 500m);
        var b = await SeedAccountAsync(owner, "New savings", 0m);
        var holiday = await SeedJarAsync(a, "Holiday");

        var error = await RunAgainstHeldLockAsync(new[] { b.Id },
            db => new UpdateJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateJarCommand(
                holiday.Id, "Holiday", JarKind.Goal, 1000m, null, AccrualMethod.TargetByDate, b.Id), Ct));

        error.Should().BeNull();
        await using var verify = fixture.CreateContext();
        (await verify.Jars.AsNoTracking().SingleAsync(j => j.Id == holiday.Id)).FundingAccountId.Should().Be(b.Id);
    }

    [Fact]
    public async Task Deleting_a_transfer_waits_for_the_destinations_lock_and_then_keeps_it_at_or_above_zero()
    {
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Everyday", 1000m, AccountType.Current);
        var b = await SeedAccountAsync(owner, "Savings", 200m);
        Guid transferId;
        await using (var seed = fixture.CreateContext())
        {
            transferId = (await new CreateTransferCommandHandler(seed, new CurrentUserStub(owner)).Handle(
                new CreateTransferCommand(new DateOnly(2026, 1, 15), 100m, a.Id, b.Id, ReceivedOn: new DateOnly(2026, 1, 15)), Ct)).Id;
        }

        // A 250 payment from B relies on the 100 received: B 200 + 100 - 250 = 50.
        var error = await RunAgainstHeldLockAsync(new[] { b.Id },
            db => new DeleteTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(new DeleteTransactionCommand(transferId), Ct),
            racing: db =>
            {
                db.Transactions.Add(Expense(b, 250m, Today));
                return Task.CompletedTask;
            });

        error.Should().BeOfType<ValidationException>("rule 74: without the receipt B would be 50 below zero");
        await using var verify = fixture.CreateContext();
        var accountB = await verify.Accounts.AsNoTracking().SingleAsync(x => x.Id == b.Id);
        (await AccountLedgerReader.ReadAsync(verify, owner, new[] { accountB }, Today, Ct))[b.Id].Balance.Should().Be(50m);
    }

    [Fact]
    public async Task Confirming_a_receipt_waits_for_the_destinations_lock()
    {
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Everyday", 1000m, AccountType.Current);
        var b = await SeedAccountAsync(owner, "Savings", 0m);
        Guid transferId;
        await using (var seed = fixture.CreateContext())
        {
            transferId = (await new CreateTransferCommandHandler(seed, new CurrentUserStub(owner)).Handle(
                new CreateTransferCommand(new DateOnly(2026, 1, 15), 100m, a.Id, b.Id), Ct)).Id;
        }

        var error = await RunAgainstHeldLockAsync(new[] { b.Id },
            db => new ConfirmTransferLegsCommandHandler(db, new CurrentUserStub(owner)).Handle(
                new ConfirmTransferLegsCommand(transferId, ReceivedOn: new DateOnly(2026, 1, 16)), Ct));

        error.Should().BeNull();
    }

    [Fact]
    public async Task Moving_an_income_to_another_account_waits_for_the_lock_of_the_account_it_leaves()
    {
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Everyday", 0m, AccountType.Current);
        var c = await SeedAccountAsync(owner, "Other", 0m, AccountType.Current);
        var income = new Transaction
        {
            OwnerId = owner, Date = new DateOnly(2026, 1, 10), Payee = "Salary", Amount = 300m, Currency = CurrencyCode.Eur,
            Type = TransactionType.Income, AccountId = a.Id,
        };
        await using (var seed = fixture.CreateContext())
        {
            seed.Transactions.Add(income);
            await seed.SaveChangesAsync();
        }

        // A 250 payment from A relies on the income; moving it to C would leave A at -250.
        var error = await RunAgainstHeldLockAsync(new[] { a.Id },
            db => new UpdateTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateTransactionCommand(
                income.Id, income.Date, income.Payee, income.Amount, TransactionType.Income, AccountId: c.Id), Ct),
            racing: db =>
            {
                db.Transactions.Add(Expense(a, 250m, Today));
                return Task.CompletedTask;
            });

        error.Should().BeOfType<ValidationException>("rule 74: A would be 250 below zero without the income");
        await using var verify = fixture.CreateContext();
        (await verify.Transactions.AsNoTracking().SingleAsync(t => t.Id == income.Id)).AccountId.Should().Be(a.Id);
    }

    [Fact]
    public async Task Lowering_an_opening_balance_waits_for_a_reallocation_and_then_counts_it()
    {
        var owner = NewOwner();
        var savings = await SeedAccountAsync(owner, "Savings", 500m);
        var holiday = await SeedJarAsync(savings, "Holiday");

        var error = await RunAgainstHeldLockAsync(new[] { savings.Id },
            db => new UpdateAccountCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateAccountCommand(
                savings.Id, "Savings", AccountType.Savings, 300m, Jan1), Ct),
            racing: db =>
            {
                db.JarAllocations.Add(Move(savings, Jan1, (null, -400m), (holiday.Id, 400m)));
                return Task.CompletedTask;
            });

        error.Should().BeOfType<ValidationException>("the jars hold 400, more than an opening of 300 backs (rule 70)");
        await using var verify = fixture.CreateContext();
        (await verify.Accounts.AsNoTracking().SingleAsync(x => x.Id == savings.Id)).OpeningBalance.Should().Be(500m);
    }

    [Fact]
    public async Task Two_departure_backfills_started_together_record_each_departure_once()
    {
        // MG-P2-1: two API processes starting at once. The second waits for the first's lock and
        // then finds the departure it wrote.
        var owner = NewOwner();
        var a = await SeedAccountAsync(owner, "Old savings", 500m);
        var b = await SeedAccountAsync(owner, "New savings", 0m);
        var holiday = await SeedJarAsync(a, "Holiday", 100m);
        await using (var move = fixture.CreateContext())
        {
            // A move made before departures were recorded: re-designated, nothing written down.
            var jar = await move.Jars.SingleAsync(j => j.Id == holiday.Id);
            jar.FundingAccountId = b.Id;
            await move.SaveChangesAsync();
        }

        var runs = Enumerable.Range(0, 2).Select(_ => Task.Run(async () =>
        {
            await using var db = fixture.CreateContext();
            return await JarDepartures.BackfillAsync(db, Ct);
        })).ToList();
        await Task.WhenAll(runs);

        await using var verify = fixture.CreateContext();
        (await verify.JarAllocations.CountAsync(x => x.AccountId == a.Id && x.Kind == JarAllocationKind.Departure))
            .Should().Be(1);
        (await JarLedgerReader.ReadAsync(verify, owner, Today, Ct, new[] { a.Id })).Accounts[a.Id].JarBalances
            .GetValueOrDefault(holiday.Id).Should().Be(0m);
    }
}
