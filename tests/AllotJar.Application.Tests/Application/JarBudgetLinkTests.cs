using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Templates;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The jar ↔ budget-line link. BudgetItems.SavingsId is an enforced FK to Jars.Id
/// (EF InMemory can't verify the constraint itself — these tests instead assert that the
/// only SavingsId writer is CreateJar, which needs the jar's account, rule 73), and the link
/// is what lets a jar fill: creating a jar plants its contribution line in current/future
/// months, and creating a month plants lines for jars it would otherwise miss. A bare line
/// in a Savings group is refused (a plan with no money behind it), and templates carry no
/// savings lines (rule 81).
/// </summary>
public class JarBudgetLinkTests
{
    private static BudgetMonth SeedMonth(
        ApplicationDbContext db, string ownerId, int year, int month, bool withSavingsGroup = false)
    {
        var budget = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
            },
        };
        if (withSavingsGroup)
        {
            budget.Categories.Add(new BudgetCategory
            {
                Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
            });
        }
        db.BudgetMonths.Add(budget);
        db.SaveChanges();
        return budget;
    }

    // ---- AddBudgetItem -------------------------------------------------------

    [Fact]
    public async Task AddItem_ToSavingsGroup_IsRefused_BecauseAJarNeedsItsAccount()
    {
        // Rule 73: a savings line is a jar, and a jar is only created through the jar form
        // with its designated account. The handler refuses and writes neither line nor jar.
        await using var db = NewContext();
        var month = SeedMonth(db, "user-1", 2026, 6, withSavingsGroup: true);
        var savings = month.Categories.Single(c => c.Kind == CategoryKind.Savings);
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var ex = await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new AddBudgetItemCommand(savings.Id, "Holiday", 100m), CancellationToken.None));

        ex.Errors.Should().ContainKey("Name");
        db.BudgetItems.Should().BeEmpty();
        db.Jars.Should().BeEmpty();
    }

    [Fact]
    public async Task AddItem_ToExpenseGroup_CreatesNoJar()
    {
        await using var db = NewContext();
        var month = SeedMonth(db, "user-1", 2026, 6);
        var income = month.Categories.Single();
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new AddBudgetItemCommand(income.Id, "Pay", 3000m), CancellationToken.None);

        db.BudgetItems.Single(i => i.Name == "Pay").SavingsId.Should().BeNull();
        db.Jars.Should().BeEmpty();
    }

    // ---- CreateBudgetMonth ---------------------------------------------------

    [Fact]
    public async Task CreateMonth_FromTemplate_CreatesNoSavingsLines_AndNoJars()
    {
        // Rule 81: templates keep their income and expense structure only; jars are created
        // through the jar form with an account, never minted by a template.
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: "family"),
            CancellationToken.None);

        db.BudgetItems.Where(i => i.SavingsId != null).Should().BeEmpty();
        db.Jars.Should().BeEmpty();
        dto.Categories.Should().NotContain(c => c.Kind == "Savings");
        BudgetTemplates.All.Should().OnlyContain(t => t.Groups.All(g => g.Kind != CategoryKind.Savings));
    }

    [Fact]
    public async Task CreateMonth_Copy_AppendsLinesForJarsTheCopiedMonthLacks()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        SeedMonth(db, "user-1", 2026, 6, withSavingsGroup: true);
        // A jar created after June was budgeted — June has no line for it.
        db.Jars.Add(new Jar
        {
            OwnerId = "user-1", Name = "Car Insurance", TargetAmount = 600m,
            TargetDate = new DateOnly(2026, 12, 1), Accrual = AccrualMethod.TargetByDate,
            FundingAccountId = account.Id,
        });
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        var savings = july.Categories.Single(c => c.Name == "Savings");
        var line = savings.Items.Single(i => i.Name == "Car Insurance");
        // 600 remaining over Jul..Dec = 5 whole months → 120/mo.
        line.PlannedAmount.Should().Be(120m);
        var jarId = db.Jars.Single().Id;
        db.BudgetItems.Single(i => i.Name == "Car Insurance").SavingsId.Should().Be(jarId);
    }

    [Fact]
    public async Task CreateMonth_Blank_CreatesASavingsGroupForExistingJars()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Boiler", TargetAmount = 900m, FundingAccountId = account.Id });
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        var savings = dto.Categories.Single(c => c.Kind == "Savings");
        savings.Items.Should().ContainSingle(i => i.Name == "Boiler");
    }

    [Fact]
    public async Task CreateMonth_SkipsArchivedJars_AndOtherOwnersJars()
    {
        await using var db = NewContext();
        var mine = LedgerFixtures.SeedAccount(db, "user-1");
        var theirs = LedgerFixtures.SeedAccount(db, "user-2");
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Archived", TargetAmount = 100m, IsArchived = true, FundingAccountId = mine.Id });
        db.Jars.Add(new Jar { OwnerId = "user-2", Name = "Foreign", TargetAmount = 100m, FundingAccountId = theirs.Id });
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        dto.Categories.Should().NotContain(c => c.Kind == "Savings");
    }

    // ---- CreateJar -----------------------------------------------------------

    [Fact]
    public async Task CreateJar_PlantsItsLineInTheCurrentAndFutureMonths_WithoutCountingThemAsMoney()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var now = DateTime.UtcNow;
        var next = new DateOnly(now.Year, now.Month, 1).AddMonths(1);
        SeedMonth(db, "user-1", now.Year, now.Month, withSavingsGroup: true);
        SeedMonth(db, "user-1", next.Year, next.Month, withSavingsGroup: true);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        // 1,000 due on the 1st three months out: this month and the next two plan 333.33, 333.33
        // and 333.34 (rule 35) — the third month gets its line when it is created.
        var dto = await handler.Handle(
            new CreateJarCommand("New Sofa", JarKind.Goal, 1000m, new DateOnly(now.Year, now.Month, 1).AddMonths(3),
                AccrualMethod.TargetByDate, account.Id),
            CancellationToken.None);

        var lines = db.BudgetItems.Where(i => i.SavingsId == dto.Id).ToList();
        lines.Should().HaveCount(2);
        lines.Should().OnlyContain(l => l.Name == "New Sofa");
        lines.Select(l => l.PlannedAmount).Should().Equal(333.33m, 333.33m);
        // Rule 1: the planted lines are plans, not money. The jar holds nothing until money is
        // allocated to it, and this month's plan is worked out from that empty balance.
        dto.CurrentBalance.Should().Be(0m);
        dto.PlannedThisMonth.Should().Be(333.33m);
    }

    [Fact]
    public async Task CreateJar_CreatesTheSavingsGroup_WhenTheMonthHasNone()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var now = DateTime.UtcNow;
        SeedMonth(db, "user-1", now.Year, now.Month);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null,
                AccrualMethod.TargetByDate, account.Id),
            CancellationToken.None);

        var savings = db.BudgetCategories.Single(c => c.Kind == CategoryKind.Savings);
        savings.Name.Should().Be("Savings");
        db.BudgetItems.Single(i => i.BudgetCategoryId == savings.Id).Name.Should().Be("Boiler");
    }

    [Fact]
    public async Task CreateJar_WithNoBudgetMonths_JustCreatesTheJar_AndItsInitialAllocation()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1", opening: 100m);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null,
                AccrualMethod.TargetByDate, account.Id, InitialAllocation: 50m),
            CancellationToken.None);

        db.Jars.Should().ContainSingle();
        db.BudgetItems.Should().BeEmpty();
        // Rule 77: the 50 divides the account's 100; it is not a deposit.
        dto.CurrentBalance.Should().Be(50m);
        db.JarAllocations.Should().ContainSingle().Which.Kind.Should().Be(JarAllocationKind.InitialAllocation);
    }

    [Fact]
    public async Task CreateJar_LeavesPastMonthsUntouched()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var past = new DateOnly(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1).AddMonths(-1);
        SeedMonth(db, "user-1", past.Year, past.Month, withSavingsGroup: true);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null,
                AccrualMethod.TargetByDate, account.Id),
            CancellationToken.None);

        db.BudgetItems.Should().BeEmpty();
    }

    [Fact]
    public async Task CreateJar_RefusesAnUnknownAccount()
    {
        // Rule 73: the jar's account must exist (an enforced FK on SQL Server).
        await using var db = NewContext();
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<NotFoundException>(() => handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid()),
            CancellationToken.None));
        db.Jars.Should().BeEmpty();
    }
}
