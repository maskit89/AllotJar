using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJarLedger;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Same-account reallocation (rules 6, 68, 70): the source decreases, the destination increases,
/// the account balance is untouched; the source can give at most what it actually holds, and the
/// result must leave every positive jar backed by the account's money. Cross-account moves are
/// bank transfers (rule 7) and are refused here.
/// </summary>
public class JarReallocationTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly CurrentUserStub User = new("user-1");
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-realloc-{Guid.NewGuid()}")
            .Options);

    private static Jar SeedJar(ApplicationDbContext db, Account account, string name, decimal allocated = 0m, bool archived = false)
    {
        var jar = new Jar
        {
            OwnerId = account.OwnerId, Name = name, Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id, IsArchived = archived,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        if (allocated != 0m)
        {
            LedgerFixtures.Allocate(db, account.OwnerId, account.Id, jar.Id, allocated);
        }
        return jar;
    }

    /// <summary>The rule 68 fixture: an account of 500 holding Holiday 100 and Repairs 400.</summary>
    private static (Account Account, Jar Holiday, Jar Repairs) SeedRule68(ApplicationDbContext db, decimal opening = 500m)
    {
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: opening);
        var holiday = SeedJar(db, account, "Holiday", 100m);
        var repairs = SeedJar(db, account, "Repairs", 400m);
        return (account, holiday, repairs);
    }

    private static async Task<JarAccountLedgerDto> LedgerAsync(ApplicationDbContext db, Guid accountId)
    {
        var ledgers = await new GetJarLedgerQueryHandler(db, User).Handle(new GetJarLedgerQuery(null, accountId), CancellationToken.None);
        return ledgers.Single();
    }

    private static decimal Balance(JarAccountLedgerDto ledger, Guid jarId) => ledger.Jars.Single(j => j.JarId == jarId).Balance;

    [Fact]
    public async Task Reallocate_BetweenTwoJars_MovesMoney_WithoutChangingTheAccount()
    {
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);

        var dto = await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, holiday.Id, 150m, Note: "cover the trip"), CancellationToken.None);

        dto.AccountBalance.Should().Be(500m);
        Balance(dto, holiday.Id).Should().Be(250m);
        Balance(dto, repairs.Id).Should().Be(250m);
        dto.Unallocated.Should().Be(0m);
        dto.HasBackingDeficit.Should().BeFalse();

        var stored = await db.JarAllocations.Include(a => a.Postings).SingleAsync(a => a.Kind == JarAllocationKind.Reallocation);
        stored.AccountId.Should().Be(account.Id);
        stored.Date.Should().Be(Today);
        stored.Note.Should().Be("cover the trip");
        stored.TransactionId.Should().BeNull();
        stored.Postings.Should().HaveCount(2);
        stored.Postings.Sum(p => p.Amount).Should().Be(0m);
        stored.Postings.Single(p => p.JarId == repairs.Id).Amount.Should().Be(-150m);
        stored.Postings.Single(p => p.JarId == holiday.Id).Amount.Should().Be(150m);
    }

    [Fact]
    public async Task Reallocate_JarToUnallocated_ReleasesMoneyToTheFloat()
    {
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);

        var dto = await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, null, 100m), CancellationToken.None);

        dto.AccountBalance.Should().Be(500m);
        Balance(dto, repairs.Id).Should().Be(300m);
        Balance(dto, holiday.Id).Should().Be(100m);
        dto.Unallocated.Should().Be(100m);
    }

    [Fact]
    public async Task Reallocate_UnallocatedToJar_AllocatesTheFloat()
    {
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db, opening: 800m); // 300 unallocated

        var dto = await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, null, holiday.Id, 250m), CancellationToken.None);

        dto.AccountBalance.Should().Be(800m);
        Balance(dto, holiday.Id).Should().Be(350m);
        Balance(dto, repairs.Id).Should().Be(400m);
        dto.Unallocated.Should().Be(50m);
    }

    [Fact]
    public async Task Reallocate_IsRefused_WhenTheSourceJarLacksTheFunds()
    {
        // Rule 68's confirmed example: moving 150 from Holiday (100) to Repairs is not allowed;
        // Holiday can supply at most 100.
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);

        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, repairs.Id, 150m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Amount"].Single().Should().Contain("at most 100");
        db.JarAllocations.Count(a => a.Kind == JarAllocationKind.Reallocation).Should().Be(0);
        var ledger = await LedgerAsync(db, account.Id);
        Balance(ledger, holiday.Id).Should().Be(100m);
        Balance(ledger, repairs.Id).Should().Be(400m);

        // Exactly its available 100 is fine.
        await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, repairs.Id, 100m), CancellationToken.None);
        Balance(await LedgerAsync(db, account.Id), holiday.Id).Should().Be(0m);
    }

    [Fact]
    public async Task Reallocate_IsRefused_WhenUnallocatedLacksTheFunds()
    {
        await using var db = NewContext();
        var (account, holiday, _) = SeedRule68(db); // unallocated 0

        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, null, holiday.Id, 1m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Amount"].Single().Should().Contain("unallocated funds can give at most 0");
    }

    [Fact]
    public async Task Reallocate_FromANegativeJar_IsRefused_ItsAvailabilityIsZero()
    {
        // A jar taken negative by a payment (rule 5) has nothing to give; other jars' money is
        // never silently used to make the move.
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);
        var line = new BudgetItem { Name = "Holiday", SavingsId = holiday.Id, PlannedAmount = 0m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
        });
        db.SaveChanges();
        LedgerFixtures.Expense(db, "user-1", account.Id, 150m, new DateOnly(2026, 6, 10), line.Id); // Holiday −50

        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, repairs.Id, 10m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Amount"].Single().Should().Contain("at most 0");
    }

    [Fact]
    public async Task Reallocate_IsRefused_WhenTheResultLeavesPositiveJarsUnbacked()
    {
        // Rule 70: after a 150 Holiday payment the account has 350 with Holiday −50 and Repairs
        // 400. Moving money from unallocated (0) is impossible, and a move that keeps the positive
        // total above the bank money is refused even though the source alone could afford it.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 350m);
        var holiday = SeedJar(db, account, "Holiday");
        var repairs = SeedJar(db, account, "Repairs", 400m); // unallocated −50: the stored deficit rule 70 flags
        var ledger = await LedgerAsync(db, account.Id);
        ledger.HasBackingDeficit.Should().BeTrue();

        // Repairs (400) → Holiday 30: positive jars would still be 400 > 350. Refused.
        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, holiday.Id, 30m), CancellationToken.None);
        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["Amount"].Single().Should().Contain("Positive jar balances exceed");

        // Repairs → unallocated 50 brings positive jars (350) within the account's 350. Allowed.
        var dto = await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, null, 50m), CancellationToken.None);
        dto.HasBackingDeficit.Should().BeFalse();
        dto.Unallocated.Should().Be(0m);
        Balance(dto, repairs.Id).Should().Be(350m);
    }

    [Fact]
    public async Task Reallocate_CoveringANegativeJar_ClearsTheDeficit_TheRule70Example()
    {
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);
        var line = new BudgetItem { Name = "Holiday", SavingsId = holiday.Id, PlannedAmount = 0m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
        });
        db.SaveChanges();
        LedgerFixtures.Expense(db, "user-1", account.Id, 150m, new DateOnly(2026, 6, 10), line.Id);

        var before = await LedgerAsync(db, account.Id);
        before.AccountBalance.Should().Be(350m);
        Balance(before, holiday.Id).Should().Be(-50m);
        Balance(before, repairs.Id).Should().Be(400m);
        before.HasBackingDeficit.Should().BeTrue();

        var dto = await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, holiday.Id, 50m), CancellationToken.None);

        dto.AccountBalance.Should().Be(350m);
        Balance(dto, holiday.Id).Should().Be(0m);
        Balance(dto, repairs.Id).Should().Be(350m);
        dto.HasBackingDeficit.Should().BeFalse();
    }

    [Fact]
    public async Task Reallocate_AcrossAccounts_IsABankTransfer_AndRefusedHere()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, "user-1", "Savings", opening: 500m);
        var current = LedgerFixtures.SeedAccount(db, "user-1", "Current", opening: 500m, type: AccountType.Current, order: 1);
        var holiday = SeedJar(db, savings, "Holiday", 100m);
        var car = SeedJar(db, current, "Car", 100m);

        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(savings.Id, holiday.Id, car.Id, 50m), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors["DestinationJarId"].Single().Should().Contain("bank transfer");
        db.JarAllocations.Count(a => a.Kind == JarAllocationKind.Reallocation).Should().Be(0);
    }

    [Fact]
    public async Task Reallocate_IntoAnArchivedJar_IsRefused()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var holiday = SeedJar(db, account, "Holiday", 100m);
        var old = SeedJar(db, account, "Old", archived: true);

        var act = () => new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, old.Id, 10m), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("DestinationJarId");
    }

    [Fact]
    public async Task Reallocate_IsRefused_InTheFuture_AndBeforeTheAccountOpened()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m, openingDate: new DateOnly(2026, 3, 1));
        var holiday = SeedJar(db, account, "Holiday", 100m);
        var handler = new ReallocateJarMoneyCommandHandler(db, User);

        var future = () => handler.Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, null, 10m, Today.AddDays(1)), CancellationToken.None);
        (await future.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Date");

        var early = () => handler.Handle(new ReallocateJarMoneyCommand(account.Id, holiday.Id, null, 10m, new DateOnly(2026, 2, 28)), CancellationToken.None);
        (await early.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("Date");
    }

    [Fact]
    public async Task Reallocate_IsDated_SoPastMonthsReadAsOfTheirEnd()
    {
        // Rule 48: a move dated in August is part of August's balance, not July's.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 500m);
        var holiday = SeedJar(db, account, "Holiday", 100m);

        await new ReallocateJarMoneyCommandHandler(db, User)
            .Handle(new ReallocateJarMoneyCommand(account.Id, null, holiday.Id, 200m, new DateOnly(2026, 8, 15)), CancellationToken.None);

        var jars = new GetJarsQueryHandler(db, User);
        (await jars.Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 7, 31)), CancellationToken.None)).Single().CurrentBalance.Should().Be(100m);
        (await jars.Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 8, 31)), CancellationToken.None)).Single().CurrentBalance.Should().Be(300m);
    }

    [Fact]
    public async Task Reallocate_IsOwnerScoped()
    {
        await using var db = NewContext();
        var (account, holiday, repairs) = SeedRule68(db);

        var act = () => new ReallocateJarMoneyCommandHandler(db, new CurrentUserStub("user-2"))
            .Handle(new ReallocateJarMoneyCommand(account.Id, repairs.Id, holiday.Id, 10m), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public void Validator_RequiresAPositiveAmount_AndTwoDifferentPlaces()
    {
        var validator = new ReallocateJarMoneyCommandValidator();
        var account = Guid.NewGuid();
        var jar = Guid.NewGuid();

        validator.Validate(new ReallocateJarMoneyCommand(account, jar, null, 0m)).Errors
            .Should().Contain(e => e.PropertyName == "Amount");
        validator.Validate(new ReallocateJarMoneyCommand(account, jar, jar, 10m)).Errors
            .Should().Contain(e => e.PropertyName == "DestinationJarId");
        validator.Validate(new ReallocateJarMoneyCommand(account, null, null, 10m)).Errors
            .Should().Contain(e => e.PropertyName == "DestinationJarId");
        validator.Validate(new ReallocateJarMoneyCommand(account, jar, null, 10m)).IsValid.Should().BeTrue();
    }
}
