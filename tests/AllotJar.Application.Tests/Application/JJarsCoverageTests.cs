using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Gap-fill coverage for the JARS catalog (docs/testing/cases/13-jars.md) at the
/// Application/domain layer: the archive/restore soft-flag round trip (the untested
/// <c>{archived:false}</c> restore leg), the update handler echoing a stored accrual
/// method and recurrence cycle rather than forcing the form's defaults, and the Jars page
/// and budget grid reading one actual-money ledger. Every test
/// cites the JAR-NNN case(s) it automates. Conventions mirror JarsTests /
/// JarLifecycleTests (EF InMemory context, CurrentUserStub, FluentAssertions 7).
/// </summary>
public class JJarsCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-jarcov-{Guid.NewGuid()}")
            .Options);

    /// <summary>A jar in <paramref name="account"/>; <paramref name="allocated"/> is an initial allocation of the account's money (rule 77).</summary>
    private static Jar SeedJar(
        ApplicationDbContext db, string ownerId, Guid id, decimal target, Account account,
        AccrualMethod accrual = AccrualMethod.TargetByDate, DateOnly? targetDate = null,
        decimal allocated = 0m, bool archived = false, JarKind kind = JarKind.Recurring,
        string name = "Holiday", int? recurMonths = null)
    {
        var jar = new Jar
        {
            Id = id,
            OwnerId = ownerId,
            Name = name,
            Kind = kind,
            TargetAmount = target,
            Accrual = accrual,
            TargetDate = targetDate,
            FundingAccountId = account.Id,
            IsArchived = archived,
            RecurMonths = recurMonths,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        if (allocated != 0m)
        {
            LedgerFixtures.Allocate(db, ownerId, account.Id, id, allocated);
        }
        return jar;
    }

    // ---- JAR-071: restore an archived jar via PUT …/archive {archived:false} ------

    [Fact]
    public async Task Restore_ClearsTheArchivedFlag_AndReturnsItToTheDefaultList()
    {
        // JAR-071 — ArchiveJarCommandHandler does `fund.IsArchived = request.Archived`
        // (a set-to-value, not a blind flip), so the endpoint doubles as restore. An
        // archived jar restored with {archived:false} re-enters the default GET and has
        // its balance/required/status re-derived at read time from the ledger. An archived
        // jar holds nothing (rule 26); once restored it takes money again. Only the archive
        // leg was covered before (JarsTests.Archive_HidesFromDefaultList).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, account, archived: true);

        var before = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);
        before.Should().BeEmpty(); // baseline: archived → excluded from the default list

        var dto = await new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveJarCommand(id, Archived: false), CancellationToken.None);

        dto.IsArchived.Should().BeFalse();
        dto.CurrentBalance.Should().Be(0m); // re-derived from the ledger: nothing allocated yet

        // Restored, it is a destination again: unallocated → jar 100.
        await new ReallocateJarMoneyCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ReallocateJarMoneyCommand(account.Id, null, id, 100m), CancellationToken.None);

        var after = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);
        after.Should().ContainSingle().Which.Id.Should().Be(id);
        after.Single().CurrentBalance.Should().Be(100m);
        (await db.Jars.SingleAsync(j => j.Id == id)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task Restore_IsIdempotent_ASecondRestoreKeepsItActive()
    {
        // JAR-071 — because the handler sets IsArchived to the requested value (not a
        // toggle), a repeated {archived:false} is idempotent and never re-archives.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, account, archived: true);
        var handler = new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new ArchiveJarCommand(id, Archived: false), CancellationToken.None);
        var second = await handler.Handle(new ArchiveJarCommand(id, Archived: false), CancellationToken.None);

        second.IsArchived.Should().BeFalse();
        (await db.Jars.SingleAsync(j => j.Id == id)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task Restore_ReEntersMonthCreateSeeding_TheInverseOfArchiveSkip()
    {
        // JAR-071 (inverse of JAR-047) — while archived, a fresh month gets NO line for
        // the jar (it is keyed out of the active-jar append). Once restored, the next
        // month create appends its contribution line again.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 600m, account, accrual: AccrualMethod.TargetByDate,
            targetDate: new DateOnly(2026, 12, 1), archived: true);

        var whileArchived = await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);
        whileArchived.Categories.Should().NotContain(c => c.Kind == "Savings");

        await new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveJarCommand(id, Archived: false), CancellationToken.None);

        var afterRestore = await new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 8, CopyFromPrevious: false), CancellationToken.None);
        afterRestore.Categories.Single(c => c.Kind == "Savings").Items
            .Should().ContainSingle(i => i.Name == "Holiday");
    }

    [Fact]
    public async Task ArchiveRoute_Throws_WhenJarOwnedByAnotherHousehold()
    {
        // JAR-071 / JAR-068 — the archive/restore route re-checks OwnerId after finding
        // the row, so another household's jar id is forbidden (the restore leg included).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, account, archived: true);

        var handler = new ArchiveJarCommandHandler(db, new CurrentUserStub("user-2"));

        await Assert.ThrowsAsync<ForbiddenAccessException>(() => handler.Handle(
            new ArchiveJarCommand(id, Archived: false), CancellationToken.None));
    }

    [Fact]
    public async Task ArchiveRoute_Throws_WhenJarIdIsUnknown()
    {
        // JAR-071 / JAR-067 — an unknown id on the archive/restore route 404s ("Sinking
        // fund {id} was not found."); there is no DELETE route — jars are only ever
        // soft-archived/restored.
        await using var db = NewContext();

        var ex = await Assert.ThrowsAsync<NotFoundException>(() =>
            new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"))
                .Handle(new ArchiveJarCommand(Guid.NewGuid(), Archived: false), CancellationToken.None));

        ex.Message.Should().Contain("was not found.");
    }

    // ---- Rule 46: an edit revises the current and later plans; a rename leaves them ----

    [Fact]
    public async Task Update_RevisesThisMonthsAndLaterLines_WhenThePlanChanges_AndLeavesPastMonthsAndRenamesAlone()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var current = new DateOnly(today.Year, today.Month, 1);
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Sofa", Kind = JarKind.Goal, TargetAmount = 300m,
            TargetDate = current.AddMonths(3), Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        // Last month (history), this month and next month each carry the jar's line: 100 each (rule 12).
        foreach (var offset in new[] { -1, 0, 1 })
        {
            var m = current.AddMonths(offset);
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = "user-1", Year = m.Year, Month = m.Month, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory>
                {
                    new()
                    {
                        Name = "Savings", Kind = CategoryKind.Savings,
                        Items = new List<BudgetItem> { new() { Name = "Sofa", PlannedAmount = 100m, SavingsId = jar.Id } },
                    },
                },
            });
        }
        db.SaveChanges();
        var handler = new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"));

        // A rename changes nothing about the plan, so every line stays as it is.
        await handler.Handle(new UpdateJarCommand(
            jar.Id, "New sofa", JarKind.Goal, 300m, current.AddMonths(3), AccrualMethod.TargetByDate, account.Id), CancellationToken.None);
        Lines(db, jar.Id).Should().Equal(100m, 100m, 100m);

        // Doubling the target revises this month and next to 200 each; last month stays 100.
        var dto = await handler.Handle(new UpdateJarCommand(
            jar.Id, "New sofa", JarKind.Goal, 600m, current.AddMonths(3), AccrualMethod.TargetByDate, account.Id), CancellationToken.None);
        Lines(db, jar.Id).Should().Equal(100m, 200m, 200m);
        dto.PlannedThisMonth.Should().Be(200m);

        // Switching to a fixed 50 a month plans 50 in this month and next (rule 18: 600 needs twelve).
        await handler.Handle(new UpdateJarCommand(
            jar.Id, "New sofa", JarKind.Goal, 600m, null, AccrualMethod.FixedMonthly, account.Id, MonthlyContribution: 50m), CancellationToken.None);
        Lines(db, jar.Id).Should().Equal(100m, 50m, 50m);
        (await db.Jars.SingleAsync()).MonthlyContribution.Should().Be(50m);

        static List<decimal> Lines(ApplicationDbContext db, Guid jarId) => db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .Where(i => i.SavingsId == jarId)
            .OrderBy(i => i.BudgetCategory.BudgetMonth.Year).ThenBy(i => i.BudgetCategory.BudgetMonth.Month)
            .Select(i => i.PlannedAmount)
            .ToList();
    }

    // ---- JAR-040: a stale client omitting recurMonths can't reset a chosen cycle ------

    [Fact]
    public async Task Update_Recurring_OmittingRecurMonths_KeepsTheStoredCycle()
    {
        // JAR-040 — UpdateJarCommandHandler falls back `RecurMonths ?? stored ?? 12` for a
        // Recurring jar, so an older client that omits recurMonths can't silently reset a
        // chosen 3-month cycle back to yearly.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = new Jar
        {
            OwnerId = "user-1",
            Name = "Road Tax",
            Kind = JarKind.Recurring,
            TargetAmount = 150m,
            TargetDate = new DateOnly(2026, 10, 1),
            Accrual = AccrualMethod.TargetByDate,
            RecurMonths = 3,
            FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();

        var dto = await new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateJarCommand(
                jar.Id, "Road Tax", JarKind.Recurring, 150m, new DateOnly(2026, 10, 1), AccrualMethod.TargetByDate, account.Id,
                RecurMonths: null), CancellationToken.None);

        dto.RecurMonths.Should().Be(3); // preserved, not reset to 12
    }

    // ---- JAR-053: the Jars page and the budget grid read the same ledger ------------

    [Fact]
    public async Task JarAndGridReads_AgreeOnAllocatedMoney_AndIgnoreThePlan()
    {
        // Both endpoints consume the actual ledger (rules 1, 48): the 50 allocated is the
        // balance on the Jars page and the grid's SavingsAvailable for July; the planned 30
        // is a plan and counts nowhere.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jarId = Guid.NewGuid();
        SeedJar(db, "user-1", jarId, target: 300m, account, allocated: 50m);
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1",
            Year = 2026,
            Month = 7,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Gifts", SavingsId = jarId, PlannedAmount = 30m },
                    },
                },
            },
        });
        db.SaveChanges();

        var jars = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(AsOf: new DateOnly(2026, 7, 15)), CancellationToken.None);
        var jarBalance = jars.Single().CurrentBalance;

        var july = await new GetBudgetMonthQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        var gridAvailable = july.Categories.Single(c => c.Kind == "Savings").Items.Single().SavingsAvailable;

        jarBalance.Should().Be(50m);        // allocated only; the planned 30 never counts
        gridAvailable.Should().Be(50m);     // the same ledger, as of July's month-end
    }

    // ---- JAR-066 / JAR-065: permissive amount + bounded recurrence validators ---------

    [Fact]
    public void Validator_RejectsNegativeInitialAllocation_AndNegativeTarget()
    {
        // JAR-066 (rule 77) — "already set aside" divides money that is in the account, so it
        // is zero or more; a negative amount is not a way to record a shortfall. The target
        // is floored at 0 as before.
        var validator = new CreateJarCommandValidator();

        validator.Validate(new CreateJarCommand(
                "Overdrawn", JarKind.Goal, 300m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid(), InitialAllocation: -100m))
            .Errors.Should().Contain(e => e.PropertyName == "InitialAllocation");

        validator.Validate(new CreateJarCommand(
                "Set aside", JarKind.Goal, 300m, new DateOnly(2027, 1, 1),
                AccrualMethod.TargetByDate, Guid.NewGuid(), InitialAllocation: 100m))
            .IsValid.Should().BeTrue();

        validator.Validate(new CreateJarCommand(
                "Bad target", JarKind.Goal, -1m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid()))
            .IsValid.Should().BeFalse();
    }

    [Fact]
    public void Validator_RecurMonths_Accepts120_Rejects121()
    {
        // JAR-065 — the repeat cycle is inclusive [1,120]: 120 is accepted, 121 rejected
        // with "Repeat cycle must be between 1 and 120 months." (0 is already covered in
        // JarLifecycleTests; this pins the upper boundary.)
        var validator = new CreateJarCommandValidator();

        validator.Validate(new CreateJarCommand(
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1),
                AccrualMethod.TargetByDate, Guid.NewGuid(), RecurMonths: 120))
            .IsValid.Should().BeTrue();

        validator.Validate(new CreateJarCommand(
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1),
                AccrualMethod.TargetByDate, Guid.NewGuid(), RecurMonths: 121))
            .Errors.Should().Contain(e => e.ErrorMessage == "Repeat cycle must be between 1 and 120 months.");
    }
}
