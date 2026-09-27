using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Commands.CreateJar;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Guards the writers of <c>BudgetItems.SavingsId</c> — an enforced foreign key to
/// <c>Jars.Id</c>. The unit suite runs on the EF in-memory provider, which does not enforce
/// foreign keys, so a bare <c>Guid.NewGuid()</c> passes there but throws
/// <c>DbUpdateException</c> against real SQL Server (the production crash PR #142 fixed).
/// Since rule 73 the only writer is CreateJar (with its designated account, itself an
/// enforced FK to <c>Accounts.Id</c>); AddBudgetItem refuses savings lines, templates carry
/// none (rule 81) and registration seeds nothing. These run the handlers against SQL Server.
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

    private static async Task<Account> SeedAccountAsync(ApplicationDbContext db, string ownerId)
    {
        var account = new Account
        {
            OwnerId = ownerId, Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur,
            OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
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

    // ---- Former crash path 1: a line in a Savings group is refused (rule 73) --------------

    [Fact]
    public async Task AddBudgetItem_ToSavingsGroup_IsRefused_AndWritesNothing()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var month = await SeedMonthAsync(db, owner, 2026, 6, withSavingsGroup: true);
        var savings = month.Categories.Single(c => c.Kind == CategoryKind.Savings);

        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub(owner));
        var act = () => handler.Handle(new AddBudgetItemCommand(savings.Id, "Holiday", 100m), CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();
        var reloaded = await LoadMonthGraphAsync(owner);
        reloaded.Categories.SelectMany(c => c.Items).Should().BeEmpty();
        await using var verify = _fixture.CreateContext();
        (await verify.Jars.AnyAsync(j => j.OwnerId == owner)).Should().BeFalse();
    }

    // ---- Former crash path 2: templates carry no savings lines (rule 81) ------------------

    [Theory]
    [InlineData("essentials")]
    [InlineData("student")]
    [InlineData("family")]
    public async Task CreateBudgetMonth_FromTemplate_PersistsNoSavingsLinesAndNoJars(string templateKey)
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub(owner));

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: templateKey),
            CancellationToken.None);

        var reloaded = await LoadMonthGraphAsync(owner);
        reloaded.Categories.Should().NotContain(c => c.Kind == CategoryKind.Savings);
        reloaded.Categories.SelectMany(c => c.Items).Should().OnlyContain(i => i.SavingsId == null);
        await using var verify = _fixture.CreateContext();
        (await verify.Jars.AnyAsync(j => j.OwnerId == owner)).Should().BeFalse();
    }

    // ---- Crash path 3: create a jar ------------------------------------------

    [Fact]
    public async Task CreateJar_PlantsSavingsLineInTheCurrentMonth()
    {
        var owner = NewOwner();
        var now = DateTime.UtcNow;
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner);
        await SeedMonthAsync(db, owner, now.Year, now.Month, withSavingsGroup: true);

        var handler = new CreateJarCommandHandler(db, new CurrentUserStub(owner));
        // Appends a budget line with SavingsId = the new jar's id; must not trip the FK. The jar's
        // FundingAccountId is an enforced FK too, and the initial allocation is written under the
        // account's ledger lock.
        var dto = await handler.Handle(
            new CreateJarCommand("New Sofa", JarKind.Goal, 1200m, null,
                AccrualMethod.TargetByDate, account.Id, InitialAllocation: 200m),
            CancellationToken.None);

        dto.CurrentBalance.Should().Be(200m);
        await using var verify = _fixture.CreateContext();
        var jar = await verify.Jars.AsNoTracking().SingleAsync(j => j.OwnerId == owner);
        jar.Id.Should().Be(dto.Id);
        jar.FundingAccountId.Should().Be(account.Id);
        (await verify.JarAllocations.AsNoTracking().Include(a => a.Postings).SingleAsync(a => a.OwnerId == owner))
            .Postings.Sum(p => p.Amount).Should().Be(0m);

        var reloaded = await LoadMonthGraphAsync(owner);
        var line = reloaded.Categories.SelectMany(c => c.Items).Single(i => i.SavingsId == dto.Id);
        line.Name.Should().Be("New Sofa");
    }

    // ---- Rule 73 on the database: a jar cannot be written without a real account ----------

    [Fact]
    public async Task CreateJar_WithAnUnknownAccount_NeverReachesTheDatabase()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();

        var handler = new CreateJarCommandHandler(db, new CurrentUserStub(owner));
        var act = () => handler.Handle(
            new CreateJarCommand("Orphan", JarKind.Goal, 100m, null,
                AccrualMethod.TargetByDate, Guid.NewGuid()),
            CancellationToken.None);

        await act.Should().ThrowAsync<NotFoundException>();
        await using var verify = _fixture.CreateContext();
        (await verify.Jars.AnyAsync(j => j.OwnerId == owner)).Should().BeFalse();
    }

    // ---- Registration seeds nothing (rule 81) --------------------------------------------

    [Fact]
    public async Task HouseholdBootstrap_SeedsNoMonthJarOrAccount()
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

        var created = await HouseholdBootstrap.EnsureOwnHouseholdAsync(db, user, DateTime.UtcNow);

        created.Should().BeTrue();
        await using var verify = _fixture.CreateContext();
        (await verify.BudgetMonths.AnyAsync(m => m.OwnerId == owner)).Should().BeFalse();
        (await verify.Jars.AnyAsync(j => j.OwnerId == owner)).Should().BeFalse();
        (await verify.Accounts.AnyAsync(a => a.OwnerId == owner)).Should().BeFalse();
        (await verify.HouseholdMemberships.AsNoTracking()
            .SingleAsync(m => m.OwnerId == owner && m.UserId == owner)).Role
            .Should().Be(HouseholdRole.Owner);
        (await verify.HouseholdMembers.AsNoTracking().CountAsync(m => m.OwnerId == owner))
            .Should().Be(1);
    }
}
