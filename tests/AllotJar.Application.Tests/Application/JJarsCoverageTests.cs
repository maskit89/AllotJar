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
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Gap-fill coverage for the JARS catalog (docs/testing/cases/13-jars.md) at the
/// Application/domain layer: the archive/restore soft-flag round trip (the untested
/// <c>{archived:false}</c> restore leg), the update handler echoing a stored accrual
/// method and recurrence cycle rather than forcing the form's defaults, and the two
/// legitimately-different jar balance flavours (Jars page vs budget grid). Every test
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

    private static Jar SeedJar(
        ApplicationDbContext db, string ownerId, Guid id, decimal target,
        AccrualMethod accrual = AccrualMethod.TargetByDate, DateOnly? targetDate = null,
        decimal opening = 0m, bool archived = false, JarKind kind = JarKind.Recurring,
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
            OpeningBalance = opening,
            IsArchived = archived,
            RecurMonths = recurMonths,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    // ---- JAR-071: restore an archived jar via PUT …/archive {archived:false} ------

    [Fact]
    public async Task Restore_ClearsTheArchivedFlag_AndReturnsItToTheDefaultList()
    {
        // JAR-071 — ArchiveJarCommandHandler does `fund.IsArchived = request.Archived`
        // (a set-to-value, not a blind flip), so the endpoint doubles as restore. An
        // archived jar restored with {archived:false} re-enters the default GET and has
        // its balance/required/status re-derived at read time. Only the archive leg was
        // covered before (JarsTests.Archive_HidesFromDefaultList).
        await using var db = NewContext();
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, opening: 100m, archived: true);

        var before = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);
        before.Should().BeEmpty(); // baseline: archived → excluded from the default list

        var dto = await new ArchiveJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new ArchiveJarCommand(id, Archived: false), CancellationToken.None);

        dto.IsArchived.Should().BeFalse();
        dto.CurrentBalance.Should().Be(100m); // re-derived: opening 100 + tracked 0

        var after = await new GetJarsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetJarsQuery(), CancellationToken.None);
        after.Should().ContainSingle().Which.Id.Should().Be(id);
        (await db.Jars.SingleAsync(j => j.Id == id)).IsArchived.Should().BeFalse();
    }

    [Fact]
    public async Task Restore_IsIdempotent_ASecondRestoreKeepsItActive()
    {
        // JAR-071 — because the handler sets IsArchived to the requested value (not a
        // toggle), a repeated {archived:false} is idempotent and never re-archives.
        await using var db = NewContext();
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, archived: true);
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
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 600m, accrual: AccrualMethod.TargetByDate,
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
        var id = Guid.NewGuid();
        SeedJar(db, "user-1", id, target: 300m, archived: true);

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

    // ---- JAR-035 / JAR-034: an edit echoes the stored accrual method + cover window ---

    [Fact]
    public async Task Update_KeepsStoredStraightLineAccrual_AndCoverWindow_OnAPlainRename()
    {
        // JAR-035 / JAR-034 — an imported StraightLine jar carries a cover window the
        // form never surfaces; a rename must ECHO accrual:0 + the window rather than
        // force the form default (TargetByDate, ÷12). The handler persists exactly what
        // is sent, so the jar keeps StraightLine (target ÷ cover months).
        await using var db = NewContext();
        var id = Guid.NewGuid();
        db.Jars.Add(new Jar
        {
            Id = id,
            OwnerId = "user-1",
            Name = "Car Insurance",
            Kind = JarKind.Recurring,
            TargetAmount = 600m,
            Accrual = AccrualMethod.StraightLine,
            CoverStart = new DateOnly(2026, 1, 1),
            CoverEnd = new DateOnly(2026, 12, 31),
        });
        db.SaveChanges();

        var dto = await new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateJarCommand(
                id, "Car Cover", JarKind.Recurring, 600m, TargetDate: null,
                CoverStart: new DateOnly(2026, 1, 1), CoverEnd: new DateOnly(2026, 12, 31),
                AccrualMethod.StraightLine, OpeningBalance: 0m, OpeningAsOf: null,
                FundingAccountId: null, RecurMonths: 12), CancellationToken.None);

        dto.Accrual.Should().Be(AccrualMethod.StraightLine);
        dto.CoverStart.Should().Be(new DateOnly(2026, 1, 1));
        dto.CoverEnd.Should().Be(new DateOnly(2026, 12, 31));
        // StraightLine ÷ cover months (Jan→Dec = 11 whole months): 600 / 11 = 54.55 —
        // NOT the TargetByDate ÷12 (50.00) a forced-default edit would have produced.
        dto.RequiredMonthlyContribution.Should().Be(54.55m);

        (await db.Jars.SingleAsync(j => j.Id == id)).Accrual.Should().Be(AccrualMethod.StraightLine);
    }

    // ---- JAR-040: a stale client omitting recurMonths can't reset a chosen cycle ------

    [Fact]
    public async Task Update_Recurring_OmittingRecurMonths_KeepsTheStoredCycle()
    {
        // JAR-040 — UpdateJarCommandHandler falls back `RecurMonths ?? stored ?? 12` for a
        // Recurring jar, so an older client that omits recurMonths can't silently reset a
        // chosen 3-month cycle back to yearly.
        await using var db = NewContext();
        var jar = new Jar
        {
            OwnerId = "user-1",
            Name = "Road Tax",
            Kind = JarKind.Recurring,
            TargetAmount = 150m,
            TargetDate = new DateOnly(2026, 10, 1),
            Accrual = AccrualMethod.TargetByDate,
            RecurMonths = 3,
        };
        db.Jars.Add(jar);
        db.SaveChanges();

        var dto = await new UpdateJarCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateJarCommand(
                jar.Id, "Road Tax", JarKind.Recurring, 150m, new DateOnly(2026, 10, 1),
                null, null, AccrualMethod.TargetByDate, 0m, null, null,
                RecurMonths: null), CancellationToken.None);

        dto.RecurMonths.Should().Be(3); // preserved, not reset to 12
    }

    // ---- JAR-053: Jars-page balance vs budget-grid "avail." differ by the opening ------

    [Fact]
    public async Task JarsBalance_IncludesOpeningAndAllMonths_WhileGridAvailableExcludesOpening()
    {
        // JAR-053 — the Jars page currentBalance (opening + Σ planned−spend over ALL
        // months) and the budget grid's SavingsAvailable (planned−spend for months ≤ the
        // viewed one, WITHOUT the opening balance) legitimately differ by exactly the
        // opening balance. One July line of 30, opening 50, nothing spent.
        await using var db = NewContext();
        var jarId = Guid.NewGuid();
        SeedJar(db, "user-1", jarId, target: 300m, opening: 50m);
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

        jarBalance.Should().Be(80m);        // 50 opening + 30 planned
        gridAvailable.Should().Be(30m);     // planned only — opening excluded
        (jarBalance - gridAvailable!.Value).Should().Be(50m); // exactly the opening balance
    }

    // ---- JAR-066 / JAR-065: permissive amount + bounded recurrence validators ---------

    [Fact]
    public void Validator_AllowsNegativeOpeningBalance_ButNotNegativeTarget()
    {
        // JAR-066 — opening balance may be negative (range [−max, +max]); only the target
        // is floored at 0. The modal blocks a typed negative, so a negative opening is an
        // API/importer-only path the server must accept.
        var validator = new CreateJarCommandValidator();

        validator.Validate(new CreateJarCommand(
                "Overdrawn", JarKind.Goal, 300m, null, null, null,
                AccrualMethod.TargetByDate, OpeningBalance: -100m, null, null))
            .IsValid.Should().BeTrue();

        validator.Validate(new CreateJarCommand(
                "Bad target", JarKind.Goal, -1m, null, null, null,
                AccrualMethod.TargetByDate, 0m, null, null))
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
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1), null, null,
                AccrualMethod.TargetByDate, 0m, null, null, RecurMonths: 120))
            .IsValid.Should().BeTrue();

        validator.Validate(new CreateJarCommand(
                "X", JarKind.Recurring, 100m, new DateOnly(2026, 10, 1), null, null,
                AccrualMethod.TargetByDate, 0m, null, null, RecurMonths: 121))
            .Errors.Should().Contain(e => e.ErrorMessage == "Repeat cycle must be between 1 and 120 months.");
    }
}
