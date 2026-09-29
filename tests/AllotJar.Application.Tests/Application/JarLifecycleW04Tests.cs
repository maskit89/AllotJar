using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Commands.DeleteBudgetItem;
using AllotJar.Application.Budgets.Commands.SkipJarContribution;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Budgets.Queries.GetJarSkipPreview;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CompleteJar;
using AllotJar.Application.Jars.Commands.DeleteJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// W04 — what happens to a jar's planned lines when the jar stops or a month is skipped
/// (rules 25–27, 46–47, 55–56, 60–61, 84): completing a goal, deleting a jar that never held
/// money, archiving and restoring, skipping a month's contribution and planning it again, and
/// the refusals around each. The arithmetic of a skipped month is Domain/JarScheduleTests.
/// </summary>
public class JarLifecycleW04Tests
{
    private const string Owner = "user-1";

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly Current = new(Today.Year, Today.Month, 1);
    private static readonly DateOnly Next = Current.AddMonths(1);
    private static readonly DateOnly After = Current.AddMonths(2);

    private static CurrentUserStub User(string id = Owner) => new(id);

    /// <summary>A 300 goal due on the 1st in three months: 100 a month over this month and the next two.</summary>
    private static Jar SeedGoal(ApplicationDbContext db, Account account, decimal target = 300m, DateOnly? due = null, JarKind kind = JarKind.Goal)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Sofa", Kind = kind, TargetAmount = target, TargetDate = due ?? Current.AddMonths(3),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
            RecurMonths = kind == JarKind.Recurring ? 12 : null,
            CycleDeadline = kind == JarKind.Recurring ? due ?? Current.AddMonths(3) : null,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static BudgetItem SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar, decimal planned, bool skipped = false)
    {
        var line = new BudgetItem { Name = jar.Name, PlannedAmount = planned, SavingsId = jar.Id, IsSkipped = skipped };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    /// <summary>The goal with its three planned months; returns the lines by month.</summary>
    private static Dictionary<DateOnly, BudgetItem> SeedPlan(ApplicationDbContext db, Jar jar) => new()
    {
        [Current] = SeedMonth(db, Current, jar, 100m),
        [Next] = SeedMonth(db, Next, jar, 100m),
        [After] = SeedMonth(db, After, jar, 100m),
    };

    private static List<BudgetItem> LinesFor(ApplicationDbContext db, Jar jar, DateOnly month) => db.BudgetItems
        .AsNoTracking()
        .Where(i => i.SavingsId == jar.Id && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month)
        .ToList();

    private static decimal LineFor(ApplicationDbContext db, Jar jar, DateOnly month) => LinesFor(db, jar, month).Single().PlannedAmount;

    private static Task<JarDto> CompleteAsync(ApplicationDbContext db, Jar jar) =>
        new CompleteJarCommandHandler(db, User()).Handle(new CompleteJarCommand(jar.Id), CancellationToken.None);

    private static Task DeleteAsync(ApplicationDbContext db, Jar jar) =>
        new DeleteJarCommandHandler(db, User()).Handle(new DeleteJarCommand(jar.Id), CancellationToken.None);

    private static Task<JarDto> ArchiveAsync(ApplicationDbContext db, Jar jar, bool archived = true) =>
        new ArchiveJarCommandHandler(db, User()).Handle(new ArchiveJarCommand(jar.Id, archived), CancellationToken.None);

    private static Task<Budgets.Dtos.BudgetMonthDto> SkipAsync(ApplicationDbContext db, BudgetItem line, bool skipped = true) =>
        new SkipJarContributionCommandHandler(db, User()).Handle(new SkipJarContributionCommand(line.Id, skipped), CancellationToken.None);

    private static Task<JarScheduleDto> PreviewSkipAsync(ApplicationDbContext db, BudgetItem line) =>
        new GetJarSkipPreviewQueryHandler(db, User()).Handle(new GetJarSkipPreviewQuery(line.Id), CancellationToken.None);

    private static async Task<JarDto> ReadAsync(ApplicationDbContext db, Jar jar) =>
        (await new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(IncludeArchived: true), CancellationToken.None)).Single(j => j.Id == jar.Id);

    // ---- Rules 55–56: completing a goal -----------------------------------------------------

    [Fact]
    public async Task Rule55_Completing_StopsThePlan_FromThisMonthOn_AndKeepsTheMoney()
    {
        // 40 went in this month. Completing cuts this month's line to that 40 (nothing more is
        // asked for), removes the later months' plan lines — except one a transaction sits on,
        // which stays at 0 so the history keeps its place — and moves no money (rule 56).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        var lines = SeedPlan(db, jar);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 40m, Today);
        // A transaction assigned to next month's line (rule 79 attributes only expenses to a jar,
        // so this income leaves the balance alone; it just pins the line).
        LedgerFixtures.Income(db, Owner, account.Id, 10m, Today, lines[Next].Id);

        var dto = await CompleteAsync(db, jar);

        dto.Status.Should().Be("Completed");
        dto.CompletedOn.Should().Be(Today);
        dto.IsArchived.Should().BeFalse();
        dto.CurrentBalance.Should().Be(40m);
        dto.PlannedThisMonth.Should().Be(40m);
        dto.CanDelete.Should().BeFalse("it has held money");
        LineFor(db, jar, Current).Should().Be(40m);
        LinesFor(db, jar, Next).Should().ContainSingle().Which.PlannedAmount.Should().Be(0m);
        LinesFor(db, jar, After).Should().BeEmpty();
        // The other lines of those months are untouched.
        db.BudgetItems.Count(i => i.Name == "Salary").Should().Be(3);
    }

    [Fact]
    public async Task Rule55_ACompletedGoal_IsLeftOutOfTheNextMonthsPlanning_AndStillListed()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedPlan(db, jar);
        await CompleteAsync(db, jar);

        // Nothing is planned for it any more, and replanting (an edit that keeps it a Goal) plants nothing.
        var edited = await new UpdateJarCommandHandler(db, User()).Handle(new UpdateJarCommand(
            jar.Id, "Sofa (done)", JarKind.Goal, 300m, Current.AddMonths(6), AccrualMethod.TargetByDate, account.Id), CancellationToken.None);

        edited.Status.Should().Be("Completed");
        edited.PlannedThisMonth.Should().Be(0m);
        LinesFor(db, jar, After).Should().BeEmpty();
        (await new GetJarsQueryHandler(db, User()).Handle(new GetJarsQuery(), CancellationToken.None))
            .Should().ContainSingle(j => j.Id == jar.Id, "a completed jar stays on the list with its history");
    }

    [Fact]
    public async Task Rule55_Completing_IsRefused_ForARecurringJar_AnArchivedOrCompletedOne_AndAnOverdrawnBalance()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);

        var recurring = SeedGoal(db, account, kind: JarKind.Recurring);
        (await FluentActions.Awaiting(() => CompleteAsync(db, recurring)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Contain("recurring jar");

        var goal = SeedGoal(db, account);
        SeedPlan(db, goal);
        await CompleteAsync(db, goal);
        (await FluentActions.Awaiting(() => CompleteAsync(db, goal)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Contain("already completed");

        var archived = SeedGoal(db, account);
        archived.IsArchived = true;
        await db.SaveChangesAsync();
        (await FluentActions.Awaiting(() => CompleteAsync(db, archived)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Contain("archived");

        // Overdrawn (HANDOVER O3 stays open): 50 spent from a jar holding nothing.
        var overdrawn = SeedGoal(db, account);
        var line = SeedMonth(db, Current.AddMonths(-1), overdrawn, 100m);
        LedgerFixtures.Expense(db, Owner, account.Id, 50m, Today.AddDays(-1), line.Id);
        (await FluentActions.Awaiting(() => CompleteAsync(db, overdrawn)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Contain("overdrawn");
        (await db.Jars.SingleAsync(j => j.Id == overdrawn.Id)).CompletedOn.Should().BeNull();
    }

    [Fact]
    public async Task Rule55_ACompletedGoal_CannotBecomeARecurringJar()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedPlan(db, jar);
        await CompleteAsync(db, jar);

        var act = () => new UpdateJarCommandHandler(db, User()).Handle(new UpdateJarCommand(
            jar.Id, "Sofa", JarKind.Recurring, 300m, Current.AddMonths(3), AccrualMethod.TargetByDate, account.Id, RecurMonths: 12), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["Kind"].Single().Should().Contain("completed goal");
        (await db.Jars.SingleAsync()).Kind.Should().Be(JarKind.Goal);
    }

    // ---- Rule 27: deleting a jar that never held money ----------------------------------------

    [Fact]
    public async Task Rule27_AJarThatNeverHeldMoney_CanBeDeleted_WithItsPlannedLinesAndCycles()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedPlan(db, jar);
        SeedMonth(db, Current.AddMonths(-1), jar, 100m); // a past plan line too: a plan, never money
        db.JarCycles.Add(new JarCycle { OwnerId = Owner, JarId = jar.Id, Deadline = Current, TargetAmount = 300m });
        db.JarRevisions.Add(JarRevision.Of(jar, DateOnly.MinValue)); // its definition history (an edit)
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();
        (await ReadAsync(db, jar)).CanDelete.Should().BeTrue();

        await DeleteAsync(db, jar);

        db.Jars.Should().BeEmpty();
        db.BudgetItems.Where(i => i.SavingsId != null).Should().BeEmpty();
        db.JarCycles.Should().BeEmpty();
        db.JarRevisions.Should().BeEmpty();
        db.BudgetItems.Count(i => i.Name == "Salary").Should().Be(4, "the months and their other lines stay");
    }

    [Fact]
    public async Task Rule27_AJarThatHasHeldMoney_CannotBeDeleted_OnlyArchived()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);

        // Money divided into it once — even if it has since all gone back out.
        var allocated = SeedGoal(db, account);
        LedgerFixtures.Allocate(db, Owner, account.Id, allocated.Id, 100m);
        LedgerFixtures.Allocate(db, Owner, account.Id, allocated.Id, -100m, kind: JarAllocationKind.Reallocation);
        (await ReadAsync(db, allocated)).CanDelete.Should().BeFalse();
        (await FluentActions.Awaiting(() => DeleteAsync(db, allocated)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Contain("has held money");

        // Or a transaction assigned to one of its lines (rule 79: that is money through the jar).
        var spent = SeedGoal(db, account);
        var line = SeedMonth(db, Current, spent, 100m);
        LedgerFixtures.Income(db, Owner, account.Id, 25m, Today, line.Id);
        (await ReadAsync(db, spent)).CanDelete.Should().BeFalse();
        await FluentActions.Awaiting(() => DeleteAsync(db, spent)).Should().ThrowAsync<ValidationException>();

        db.Jars.Should().HaveCount(2);
        db.BudgetItems.Should().Contain(i => i.Id == line.Id);
    }

    // ---- Rules 25–26: archiving cancels the plan; restoring plants it again -----------------

    [Fact]
    public async Task Rule25_Archiving_CancelsThisMonthsAndLaterContributions_AndRestoringReplantsThem()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedPlan(db, jar);
        var past = SeedMonth(db, Current.AddMonths(-1), jar, 100m);

        var archived = await ArchiveAsync(db, jar);

        archived.IsArchived.Should().BeTrue();
        jar.ArchivedOn.Should().Be(DateOnly.FromDateTime(DateTime.UtcNow), "archiving is dated, so a month that ended before it reads the jar as it was (W05)");
        archived.PlannedThisMonth.Should().Be(0m);
        LineFor(db, jar, Current).Should().Be(0m, "nothing went in this month, so nothing more is asked for");
        LinesFor(db, jar, Next).Should().BeEmpty();
        LinesFor(db, jar, After).Should().BeEmpty();
        LineFor(db, jar, Current.AddMonths(-1)).Should().Be(100m, "past months are history (rule 46)");
        db.BudgetItems.Should().Contain(i => i.Id == past.Id);

        var restored = await ArchiveAsync(db, jar, archived: false);

        restored.IsArchived.Should().BeFalse();
        jar.ArchivedOn.Should().BeNull();
        restored.PlannedThisMonth.Should().Be(100m);
        LineFor(db, jar, Current).Should().Be(100m);
        LineFor(db, jar, Next).Should().Be(100m);
        LineFor(db, jar, After).Should().Be(100m);
    }

    // ---- Rules 60–61: skipping a month's contribution ----------------------------------------

    [Fact]
    public async Task Rule61_Skipping_ThisMonth_KeepsItsLineAtZero_AndSpreadsTheRestOverTheMonthsLeft()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        var lines = SeedPlan(db, jar);

        // The preview says what the skip will do, before anything changes.
        var preview = await PreviewSkipAsync(db, lines[Current]);
        preview.Months.Select(m => (m.Planned, m.Skipped)).Should().Equal((0m, true), (150m, false), (150m, false));
        preview.Unplanned.Should().Be(0m);
        LineFor(db, jar, Current).Should().Be(100m, "a preview changes nothing");

        var month = await SkipAsync(db, lines[Current]);

        var item = month.Categories.Single(c => c.Kind == "Savings").Items.Single();
        item.IsSkipped.Should().BeTrue();
        item.PlannedAmount.Should().Be(0m);
        LineFor(db, jar, Current).Should().Be(0m);
        LineFor(db, jar, Next).Should().Be(150m);
        LineFor(db, jar, After).Should().Be(150m);
        db.BudgetItems.Count(i => i.SavingsId == jar.Id).Should().Be(3, "the skipped line stays, never deleted");

        var dto = await ReadAsync(db, jar);
        dto.SkippedThisMonth.Should().BeTrue();
        dto.PlannedThisMonth.Should().Be(0m);
        dto.FundingCompletesOn.Should().Be(Current.AddMonths(3).AddDays(-1), "the deadline is unchanged");
    }

    [Fact]
    public async Task Rule61_PlanningASkippedMonthAgain_RestoresTheEvenPlan_AndTypingAnAmountAlsoUnskipsIt()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        var lines = SeedPlan(db, jar);
        await SkipAsync(db, lines[Current]);

        var month = await SkipAsync(db, lines[Current], skipped: false);

        month.Categories.Single(c => c.Kind == "Savings").Items.Single().IsSkipped.Should().BeFalse();
        LineFor(db, jar, Current).Should().Be(100m);
        LineFor(db, jar, Next).Should().Be(100m);
        LineFor(db, jar, After).Should().Be(100m);

        // Skipped again, then the user simply types an amount on the line: that is a plan, so the
        // skip is over (the later months are the user's to adjust, as with any typed amount).
        await SkipAsync(db, lines[Current]);
        var typed = await new UpdateBudgetItemCommandHandler(db, User())
            .Handle(new UpdateBudgetItemCommand(lines[Current].Id, 30m), CancellationToken.None);
        var line = typed.Categories.Single(c => c.Kind == "Savings").Items.Single();
        line.IsSkipped.Should().BeFalse();
        line.PlannedAmount.Should().Be(30m);
    }

    [Fact]
    public async Task Rule61_SkippingTheLastMonthBeforeTheDeadline_IsAllowed_AndThePreviewSaysWhatStaysUnplanned()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account, due: Next); // due on the 1st of next month: this month alone carries the 300
        var line = SeedMonth(db, Current, jar, 300m);

        var preview = await PreviewSkipAsync(db, line);
        preview.Months.Should().ContainSingle().Which.Skipped.Should().BeTrue();
        preview.Unplanned.Should().Be(300m);

        await SkipAsync(db, line);

        LineFor(db, jar, Current).Should().Be(0m);
        (await ReadAsync(db, jar)).SkippedThisMonth.Should().BeTrue();
    }

    [Fact]
    public async Task Rule60_OnlyAJarsLine_InAMonthThatIsNotOver_ForAJarThatIsPlanning_CanBeSkipped()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        var lines = SeedPlan(db, jar);

        // A past month's contributions are history (rule 46).
        var past = SeedMonth(db, Current.AddMonths(-1), jar, 100m);
        (await FluentActions.Awaiting(() => SkipAsync(db, past)).Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(v => v).Single().Should().Contain("is over");

        // Not a jar's line at all.
        var salary = await db.BudgetItems.FirstAsync(i => i.Name == "Salary");
        (await FluentActions.Awaiting(() => SkipAsync(db, salary)).Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(v => v).Single().Should().Contain("not a jar's contribution line");

        // An archived jar plans nothing, so there is nothing to skip; the same for a completed one.
        await ArchiveAsync(db, jar);
        (await FluentActions.Awaiting(() => PreviewSkipAsync(db, lines[Current])).Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(v => v).Single().Should().Contain("nothing to skip");

        // Another household's line is not found as theirs.
        await FluentActions.Awaiting(() => new SkipJarContributionCommandHandler(db, User("user-2"))
            .Handle(new SkipJarContributionCommand(past.Id), CancellationToken.None)).Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Fact]
    public async Task Rule60_AJarsLine_CannotBeDeletedFromAMonth_TheChoiceIsSkipOrArchive()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        var lines = SeedPlan(db, jar);

        var act = () => new DeleteBudgetItemCommandHandler(db, User()).Handle(new DeleteBudgetItemCommand(lines[Current].Id), CancellationToken.None);

        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Values.SelectMany(v => v).Single()
            .Should().Contain("Skip this month's contribution, or archive the jar");
        db.BudgetItems.Should().Contain(i => i.Id == lines[Current].Id);
        db.Jars.Should().ContainSingle(j => j.Id == jar.Id && !j.IsArchived);
    }

    // ---- Rule 61: a month created after a later month was skipped (review of PR #273) --------

    [Fact]
    public async Task Rule61_CreatingAMissingMonth_PlansAroundTheMonthsSkippedAfterIt()
    {
        // 300 due in three months: 100/100/100. The month after next was skipped and this month
        // replanted to 150, but next month was never created. Creating it must plan the other
        // 150 — not 75 as if the skipped month still carried a share — and the jar's card must
        // say the funding completes next month.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedMonth(db, Current, jar, 150m);
        SeedMonth(db, After, jar, 0m, skipped: true);

        var created = await CreateMonthAsync(db, Next);

        created.Categories.SelectMany(c => c.Items).Single(i => i.SavingsId == jar.Id).PlannedAmount.Should().Be(150m);
        LineFor(db, jar, Next).Should().Be(150m);
        var dto = await ReadAsync(db, jar);
        dto.PlannedThisMonth.Should().Be(150m);
        dto.FundingCompletesOn.Should().Be(After.AddDays(-1));
    }

    [Fact]
    public async Task Rule61_CreatingTheCurrentMonth_PlansAroundALaterSkippedMonth_Too()
    {
        // Only the skipped month exists. Creating this month reads the skip from the later month
        // and plans 150, so this month and the next carry the 300 between them.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedGoal(db, account);
        SeedMonth(db, After, jar, 0m, skipped: true);

        await CreateMonthAsync(db, Current);

        LineFor(db, jar, Current).Should().Be(150m);
        (await ReadAsync(db, jar)).PlannedThisMonth.Should().Be(150m);
    }

    private static Task<Budgets.Dtos.BudgetMonthDto> CreateMonthAsync(ApplicationDbContext db, DateOnly month) =>
        new CreateBudgetMonthCommandHandler(db, User()).Handle(new CreateBudgetMonthCommand(month.Year, month.Month, CopyFromPrevious: false), CancellationToken.None);
}
