using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using Xunit;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Queries.GetBudgetMonths;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Creating a month's budget — blank, or copied forward from the previous month —
/// and listing the months a user has.
/// </summary>
public class CreateBudgetMonthTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-{Guid.NewGuid()}")
            .Options);

    // Seeds June 2026: Income(Pay 3000) + Housing(Rent 1000, spent 250 via a transaction) in GBP.
    private static void SeedJune(ApplicationDbContext db, string ownerId)
    {
        var june = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            BaseCurrency = CurrencyCode.From("GBP"),
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0,
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 3000m } },
                },
                new()
                {
                    Name = "Housing", DisplayOrder = 1,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Rent", PlannedAmount = 1000m },
                    },
                },
            },
        };
        db.BudgetMonths.Add(june);
        db.SaveChanges();

        // June's Rent has 250 spent — recorded as an assigned transaction, so we can
        // prove the copied July resets actuals (transactions don't carry over).
        var rent = june.Categories.Single(c => c.Name == "Housing").Items.Single();
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId, BudgetItemId = rent.Id, Amount = 250m, Type = TransactionType.Expense,
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task Create_CopiesStructureAndPlanned_FromPreviousMonth_ResettingActuals()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        july.Key.Should().Be("2026-07");
        july.BaseCurrency.Should().Be("GBP"); // inherited
        july.TotalIncome.Should().Be(3000m);  // planned copied
        var rent = july.Categories.Single(c => c.Name == "Housing").Items.Single(i => i.Name == "Rent");
        rent.PlannedAmount.Should().Be(1000m);
        rent.ActualAmount.Should().Be(0m);    // actuals reset
    }

    [Fact]
    public async Task Create_Blank_MakesAnEmptyIncomeGroupOnly()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        july.Categories.Should().ContainSingle();
        july.Categories[0].Kind.Should().Be("Income");
        july.Categories[0].Items.Should().BeEmpty();
        july.TotalIncome.Should().Be(0m);
    }

    [Fact]
    public async Task Create_CopyWithNoPriorMonth_FallsBackToBlank()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var june = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        june.Categories.Should().ContainSingle(c => c.Kind == "Income");
    }

    [Fact]
    public async Task Create_FirstMonth_AdoptsTheUsersPreferredCurrency()
    {
        // The account form defaults new accounts to the user's preferred currency, so the
        // first-ever month must adopt the same preference — a hardcoded EUR base would make
        // every account-attached transaction fail the account-currency invariant for a
        // non-EUR household (the CI journey regression behind this rule).
        await using var db = NewContext();
        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync("user-1").Returns(CurrencyCode.From("USD"));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"), identity);

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false), CancellationToken.None);

        var stored = await db.BudgetMonths.SingleAsync(m => m.OwnerId == "user-1");
        stored.BaseCurrency.Should().Be(CurrencyCode.From("USD"));
    }

    [Fact]
    public async Task Create_LaterMonth_InheritsThePreviousBase_NotThePreference()
    {
        // Once a budget history exists its base currency is sticky: switching the display
        // preference must not fork a household's months across currencies.
        await using var db = NewContext();
        SeedJune(db, "user-1"); // June is GBP-based
        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync("user-1").Returns(CurrencyCode.From("USD"));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"), identity);

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        var july = await db.BudgetMonths.SingleAsync(m => m.OwnerId == "user-1" && m.Month == 7);
        july.BaseCurrency.Should().Be(CurrencyCode.From("GBP"));
        await identity.DidNotReceive().GetPreferredCurrencyAsync(Arg.Any<string>());
    }

    [Fact]
    public async Task Create_Throws_WhenMonthAlreadyExists()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        await Assert.ThrowsAsync<ValidationException>(() =>
            handler.Handle(new CreateBudgetMonthCommand(2026, 6), CancellationToken.None));
    }

    [Fact]
    public async Task Create_OnlyCopiesTheCallersOwnPreviousMonth()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1"); // belongs to user-1
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-2"));

        // user-2 has no prior month, so copy falls back to a blank budget.
        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        july.Categories.Should().ContainSingle(c => c.Kind == "Income");
        july.Categories.SelectMany(c => c.Items).Should().BeEmpty();
    }

    [Fact]
    public async Task Create_Copy_PreservesExcludeFromAllocation()
    {
        await using var db = NewContext();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0,
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 3000m } },
                },
                new()
                {
                    // Excluded from allocation (the importer's "Personal Savings" surplus).
                    Name = "Personal Savings", Kind = CategoryKind.Expense, DisplayOrder = 1,
                    ExcludeFromAllocation = true,
                    Items = new List<BudgetItem> { new() { Name = "Surplus", PlannedAmount = 200m } },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        // Dropping the flag would fold this category back into the allocation pool and
        // corrupt the copied month's member split.
        var july = await db.BudgetMonths.Include(m => m.Categories)
            .SingleAsync(m => m.OwnerId == "user-1" && m.Year == 2026 && m.Month == 7);
        july.Categories.Single(c => c.Name == "Personal Savings").ExcludeFromAllocation.Should().BeTrue();
    }

    [Fact]
    public async Task Create_Copy_SkipsLinesFundingArchivedJars()
    {
        await using var db = NewContext();
        var active = new Jar { OwnerId = "user-1", Name = "Active", TargetAmount = 0m };
        var archived = new Jar { OwnerId = "user-1", Name = "Archived", TargetAmount = 0m, IsArchived = true };
        db.Jars.AddRange(active, archived);
        await db.SaveChangesAsync();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Active", PlannedAmount = 50m, SavingsId = active.Id },
                        new() { Name = "Archived", PlannedAmount = 30m, SavingsId = archived.Id },
                    },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        // Archiving a jar must stop it being funded — its line doesn't roll forward.
        var savings = july.Categories.Single(c => c.Kind == "Savings");
        savings.Items.Should().ContainSingle(i => i.Name == "Active");
        savings.Items.Should().NotContain(i => i.Name == "Archived");
    }

    [Fact]
    public async Task Create_BackfilledMonth_SeedsJarFromBalanceAsOfThatMonth_NotAllTime()
    {
        await using var db = NewContext();
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Car Insurance", Kind = JarKind.Goal,
            TargetAmount = 600m, TargetDate = new DateOnly(2026, 12, 1),
            Accrual = AccrualMethod.TargetByDate,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        // July already funds the jar to its target — an all-time balance reads ≥ 600.
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
                    Items = new List<BudgetItem>
                    {
                        new() { Name = "Car Insurance", PlannedAmount = 600m, SavingsId = jar.Id },
                    },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        // Back-fill June: its seed must ignore July's later contribution.
        var june = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false), CancellationToken.None);

        var line = june.Categories.Single(c => c.Kind == "Savings").Items.Single(i => i.Name == "Car Insurance");
        var expected = JarAccrualCalculator.RequiredMonthlyContribution(jar, new DateOnly(2026, 6, 1), 0m);
        expected.Should().BeGreaterThan(0m);        // the jar still needs funding as of June
        line.PlannedAmount.Should().Be(expected);   // not 0, which the leaked all-time balance would produce
    }

    [Fact]
    public async Task GetMonths_ListsTheUsersMonths_NewestFirst()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1");
        var create = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        await create.Handle(new CreateBudgetMonthCommand(2026, 7), CancellationToken.None);

        var months = await new GetBudgetMonthsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetBudgetMonthsQuery(), CancellationToken.None);

        months.Select(m => m.Key).Should().ContainInOrder("2026-07", "2026-06");
    }
}
