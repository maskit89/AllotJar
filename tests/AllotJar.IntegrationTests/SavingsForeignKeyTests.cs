using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Guards the three handlers that write <c>BudgetItems.SavingsId</c> — an enforced
/// foreign key to <c>Jars.Id</c>. The unit suite runs on the EF in-memory provider,
/// which does not enforce foreign keys, so a bare <c>Guid.NewGuid()</c> passes there
/// but throws <c>DbUpdateException</c> against real SQL Server (the production crash
/// PR #142 fixed). These run the same handlers against SQL Server, so re-introducing a
/// bare Guid on any of these paths fails CI here.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class SavingsForeignKeyTests
{
    private readonly SqlServerFixture _fixture;

    public SavingsForeignKeyTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    // A fresh household per test keeps them isolated on the shared database.
    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static async Task<BudgetMonth> SeedMonthAsync(
        ApplicationDbContext db, string ownerId, int year, int month, bool withSavingsGroup)
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
        await db.SaveChangesAsync();
        return budget;
    }

    private async Task<BudgetMonth> LoadMonthGraphAsync(string ownerId)
    {
        await using var verify = _fixture.CreateContext();
        return await verify.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .SingleAsync(m => m.OwnerId == ownerId);
    }

    private async Task AssertEverySavingsLineHasItsJarAsync(string ownerId, BudgetMonth month)
    {
        await using var verify = _fixture.CreateContext();
        var jarIds = (await verify.Jars
                .AsNoTracking()
                .Where(j => j.OwnerId == ownerId)
                .Select(j => j.Id)
                .ToListAsync())
            .ToHashSet();

        var savingsLines = month.Categories
            .SelectMany(c => c.Items)
            .Where(i => i.SavingsId != null)
            .ToList();

        savingsLines.Should().NotBeEmpty();
        savingsLines.Should().OnlyContain(l => jarIds.Contains(l.SavingsId!.Value));
    }

    // ---- Crash path 1: add a line to a Savings group -------------------------

    [Fact]
    public async Task AddBudgetItem_ToSavingsGroup_PersistsLineBackedByAJar()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var month = await SeedMonthAsync(db, owner, 2026, 6, withSavingsGroup: true);
        var savings = month.Categories.Single(c => c.Kind == CategoryKind.Savings);

        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub(owner));
        // Would throw DbUpdateException (FK violation) if SavingsId were a bare Guid.
        await handler.Handle(new AddBudgetItemCommand(savings.Id, "Holiday", 100m), CancellationToken.None);

        var reloaded = await LoadMonthGraphAsync(owner);
        var line = reloaded.Categories.SelectMany(c => c.Items).Single(i => i.Name == "Holiday");
        line.SavingsId.Should().NotBeNull();
        await AssertEverySavingsLineHasItsJarAsync(owner, reloaded);
    }

    // ---- Crash path 2: create a month from each starter template -------------

    [Theory]
    [InlineData("essentials")]
    [InlineData("student")]
    [InlineData("family")]
    public async Task CreateBudgetMonth_FromTemplate_PersistsSavingsLinesBackedByJars(string templateKey)
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub(owner));

        // Every template carries a Savings group; each of its lines writes a SavingsId.
        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: templateKey),
            CancellationToken.None);

        var reloaded = await LoadMonthGraphAsync(owner);
        await AssertEverySavingsLineHasItsJarAsync(owner, reloaded);
    }

    // ---- Crash path 3: create a jar ------------------------------------------

    [Fact]
    public async Task CreateJar_PlantsSavingsLineInTheCurrentMonth()
    {
        var owner = NewOwner();
        var now = DateTime.UtcNow;
        await using var db = _fixture.CreateContext();
        await SeedMonthAsync(db, owner, now.Year, now.Month, withSavingsGroup: true);

        var handler = new CreateJarCommandHandler(db, new CurrentUserStub(owner));
        // Appends a budget line with SavingsId = the new jar's id; must not trip the FK.
        var dto = await handler.Handle(
            new CreateJarCommand("New Sofa", JarKind.Goal, 1200m, null, null, null,
                AccrualMethod.TargetByDate, 0m, null, null),
            CancellationToken.None);

        await using var verify = _fixture.CreateContext();
        (await verify.Jars.AsNoTracking().SingleAsync(j => j.OwnerId == owner)).Id.Should().Be(dto.Id);

        var reloaded = await LoadMonthGraphAsync(owner);
        var line = reloaded.Categories.SelectMany(c => c.Items).Single(i => i.SavingsId == dto.Id);
        line.Name.Should().Be("New Sofa");
    }

    // ---- Bonus: the registration seeder is a fourth SavingsId writer ---------

    [Fact]
    public async Task RegistrationSeeder_CreatesSavingsGroupBackedByAJar()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();

        await BudgetSeeder.SeedDefaultMonthAsync(db, owner, 2026, 7);

        var reloaded = await LoadMonthGraphAsync(owner);
        var savings = reloaded.Categories.Single(c => c.Kind == CategoryKind.Savings);
        savings.Items.Single().SavingsId.Should().NotBeNull();
        await AssertEverySavingsLineHasItsJarAsync(owner, reloaded);
    }

    // ---- Crash path 5: "start my own budget" runs the seeder for an existing login ----

    [Fact]
    public async Task HouseholdBootstrap_StartOwnBudget_SeedsSavingsGroupBackedByAJar()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var user = new AllotJar.Infrastructure.Identity.ApplicationUser
        {
            Id = owner,
            UserName = $"{owner}@x.com",
            Email = $"{owner}@x.com",
            FirstName = "Sam",
            DisplayName = "Sam Solo",
        };
        db.Users.Add(user);
        await db.SaveChangesAsync();

        var now = DateTime.UtcNow;
        // Goes through BudgetSeeder → SavingsLines.AddBackingJar, the same enforced-FK write path.
        var created = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, now);

        created.Should().BeTrue();
        var reloaded = await LoadMonthGraphAsync(owner);
        await AssertEverySavingsLineHasItsJarAsync(owner, reloaded);

        await using var verify = _fixture.CreateContext();
        (await verify.HouseholdMemberships.AsNoTracking()
            .SingleAsync(m => m.OwnerId == owner && m.UserId == owner)).Role
            .Should().Be(HouseholdRole.Owner);
        (await verify.HouseholdMembers.AsNoTracking().CountAsync(m => m.OwnerId == owner))
            .Should().Be(1);
    }
}
