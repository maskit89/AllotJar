using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The jar ↔ budget-line link. BudgetItems.SavingsId is an enforced FK to Jars.Id
/// (EF InMemory can't verify the constraint itself — these tests instead assert every
/// SavingsId writer creates the backing Jar row), and the link is what lets a jar
/// fill: creating a jar plants its contribution line in current/future months, and
/// creating a month plants lines for jars it would otherwise miss.
/// </summary>
public class JarBudgetLinkTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

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
    public async Task AddItem_ToSavingsGroup_CreatesTheBackingJar()
    {
        await using var db = NewContext();
        var month = SeedMonth(db, "user-1", 2026, 6, withSavingsGroup: true);
        var savings = month.Categories.Single(c => c.Kind == CategoryKind.Savings);
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new AddBudgetItemCommand(savings.Id, "Holiday", 100m), CancellationToken.None);

        var line = db.BudgetItems.Single(i => i.Name == "Holiday");
        line.SavingsId.Should().NotBeNull();
        var jar = db.Jars.Single();
        jar.Id.Should().Be(line.SavingsId!.Value);
        jar.Name.Should().Be("Holiday");
        jar.OwnerId.Should().Be("user-1");
        jar.Kind.Should().Be(JarKind.Goal);
        jar.TargetAmount.Should().Be(0m);
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
    public async Task CreateMonth_FromTemplate_BacksEverySavingsLineWithAJar()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: "family"),
            CancellationToken.None);

        // The family template's Savings group: Emergency Fund, Holiday, Christmas.
        var lines = db.BudgetItems.Where(i => i.SavingsId != null).ToList();
        lines.Should().HaveCount(3);
        var jars = db.Jars.ToList();
        jars.Should().HaveCount(3);
        foreach (var line in lines)
        {
            jars.Should().ContainSingle(j => j.Id == line.SavingsId && j.Name == line.Name);
        }
        jars.Should().OnlyContain(j => j.OwnerId == "user-1");
        dto.Categories.Should().Contain(c => c.Name == "Savings");
    }

    [Fact]
    public async Task CreateMonth_Copy_AppendsLinesForJarsTheCopiedMonthLacks()
    {
        await using var db = NewContext();
        SeedMonth(db, "user-1", 2026, 6, withSavingsGroup: true);
        // A jar created after June was budgeted — June has no line for it.
        db.Jars.Add(new Jar
        {
            OwnerId = "user-1", Name = "Car Insurance", TargetAmount = 600m,
            TargetDate = new DateOnly(2026, 12, 1), Accrual = AccrualMethod.TargetByDate,
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
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Boiler", TargetAmount = 900m });
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
        db.Jars.Add(new Jar { OwnerId = "user-1", Name = "Archived", TargetAmount = 100m, IsArchived = true });
        db.Jars.Add(new Jar { OwnerId = "user-2", Name = "Foreign", TargetAmount = 100m });
        db.SaveChanges();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        dto.Categories.Should().NotContain(c => c.Kind == "Savings");
    }

    // ---- CreateJar -----------------------------------------------------------

    [Fact]
    public async Task CreateJar_PlantsItsLineInTheCurrentAndFutureMonths()
    {
        await using var db = NewContext();
        var now = DateTime.UtcNow;
        var next = new DateOnly(now.Year, now.Month, 1).AddMonths(1);
        SeedMonth(db, "user-1", now.Year, now.Month, withSavingsGroup: true);
        SeedMonth(db, "user-1", next.Year, next.Month, withSavingsGroup: true);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateJarCommand("New Sofa", JarKind.Goal, 1200m, null, null, null,
                AccrualMethod.TargetByDate, 0m, null, null),
            CancellationToken.None);

        var lines = db.BudgetItems.Where(i => i.SavingsId == dto.Id).ToList();
        lines.Should().HaveCount(2);
        lines.Should().OnlyContain(l => l.Name == "New Sofa");
        // Each month is planned the way month creation would have seeded it — the
        // open-ended remaining ÷ 12, with earlier plantings folded in:
        // month 1 = 1200/12 = 100; month 2 = (1200−100)/12 = 91.67.
        lines.Select(l => l.PlannedAmount).Order().Should().Equal(91.67m, 100m);
        // The DTO reports what the Jars page will derive from those rows.
        dto.CurrentBalance.Should().Be(191.67m);
        dto.RequiredMonthlyContribution.Should().Be(84.03m); // (1200 − 191.67) / 12
    }

    [Fact]
    public async Task CreateJar_CreatesTheSavingsGroup_WhenTheMonthHasNone()
    {
        await using var db = NewContext();
        var now = DateTime.UtcNow;
        SeedMonth(db, "user-1", now.Year, now.Month);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null, null, null,
                AccrualMethod.TargetByDate, 0m, null, null),
            CancellationToken.None);

        var savings = db.BudgetCategories.Single(c => c.Kind == CategoryKind.Savings);
        savings.Name.Should().Be("Savings");
        db.BudgetItems.Single(i => i.BudgetCategoryId == savings.Id).Name.Should().Be("Boiler");
    }

    [Fact]
    public async Task CreateJar_WithNoBudgetMonths_JustCreatesTheJar()
    {
        await using var db = NewContext();
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null, null, null,
                AccrualMethod.TargetByDate, 50m, null, null),
            CancellationToken.None);

        db.Jars.Should().ContainSingle();
        db.BudgetItems.Should().BeEmpty();
        dto.CurrentBalance.Should().Be(50m);
    }

    [Fact]
    public async Task CreateJar_LeavesPastMonthsUntouched()
    {
        await using var db = NewContext();
        var past = new DateOnly(DateTime.UtcNow.Year, DateTime.UtcNow.Month, 1).AddMonths(-1);
        SeedMonth(db, "user-1", past.Year, past.Month, withSavingsGroup: true);
        var handler = new CreateJarCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(
            new CreateJarCommand("Boiler", JarKind.Recurring, 900m, null, null, null,
                AccrualMethod.TargetByDate, 0m, null, null),
            CancellationToken.None);

        db.BudgetItems.Should().BeEmpty();
    }

    // ---- Registration seeder -------------------------------------------------

    [Fact]
    public async Task Seeder_MakesARealSavingsGroup_BackedByAJar()
    {
        await using var db = NewContext();

        await BudgetSeeder.SeedDefaultMonthAsync(db, "user-1", 2026, 7);

        var savings = db.BudgetCategories.Single(c => c.Name == "Savings");
        savings.Kind.Should().Be(CategoryKind.Savings);
        var line = db.BudgetItems.Single(i => i.BudgetCategoryId == savings.Id);
        line.Name.Should().Be("Emergency Fund");
        var jar = db.Jars.Single();
        jar.Id.Should().Be(line.SavingsId!.Value);
        jar.Name.Should().Be("Emergency Fund");
        jar.OwnerId.Should().Be("user-1");
    }
}
