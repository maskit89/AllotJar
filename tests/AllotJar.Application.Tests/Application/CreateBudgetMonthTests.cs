using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using NSubstitute;
using AllotJar.Application.Allocation;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Templates;
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
        // With no month yet the budget currency is the owner's chosen one (rule 85), the same
        // currency every new account must use (rule 63) — a hardcoded EUR base would split a
        // non-EUR household's budget from its accounts.
        await using var db = NewContext();
        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync("user-1").Returns(CurrencyCode.From("USD"));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"), identity);

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: false), CancellationToken.None);

        var stored = await db.BudgetMonths.SingleAsync(m => m.OwnerId == "user-1");
        stored.BaseCurrency.Should().Be(CurrencyCode.From("USD"));
    }

    [Theory]
    [InlineData(7, true)]  // the next month
    [InlineData(5, false)] // a month backfilled before the first one
    public async Task Create_AnyMonth_TakesTheBudgetCurrency_NotThePreference(int month, bool copy)
    {
        // Once a budget history exists its currency is the household's (rule 85): a later
        // preference must not fork the months across currencies, whichever month is added.
        await using var db = NewContext();
        SeedJune(db, "user-1"); // June is GBP-based
        var identity = Substitute.For<IIdentityService>();
        identity.GetPreferredCurrencyAsync("user-1").Returns(CurrencyCode.From("USD"));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"), identity);

        await handler.Handle(
            new CreateBudgetMonthCommand(2026, month, CopyFromPrevious: copy), CancellationToken.None);

        var created = await db.BudgetMonths.SingleAsync(m => m.OwnerId == "user-1" && m.Month == month);
        created.BaseCurrency.Should().Be(CurrencyCode.From("GBP"));
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
    public async Task Create_Copy_SkipsLinesFundingArchivedOrCompletedJars()
    {
        await using var db = NewContext();
        var active = new Jar { OwnerId = "user-1", Name = "Active", TargetAmount = 0m };
        var archived = new Jar { OwnerId = "user-1", Name = "Archived", TargetAmount = 0m, IsArchived = true };
        var completed = new Jar { OwnerId = "user-1", Name = "Completed", TargetAmount = 0m, CompletedOn = new DateOnly(2026, 6, 20) };
        db.Jars.AddRange(active, archived, completed);
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
                        new() { Name = "Completed", PlannedAmount = 20m, SavingsId = completed.Id },
                    },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        // Archiving (rule 25) or completing (rule 55) a jar must stop it being funded — its line
        // doesn't roll forward.
        var savings = july.Categories.Single(c => c.Kind == "Savings");
        savings.Items.Should().ContainSingle(i => i.Name == "Active");
        savings.Items.Should().NotContain(i => i.Name == "Archived");
        savings.Items.Should().NotContain(i => i.Name == "Completed");
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
        // Nothing saved as of 31 May: 600 over June–November (six months) = 100 — not 0, which the
        // leaked all-time balance would produce.
        line.PlannedAmount.Should().Be(100m);
        line.PlannedAmount.Should().Be(JarSchedule.PlannedFor(jar, new DateOnly(2026, 6, 1), 0m));
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

    // ---- Q1a (W06 follow-up): a blank month is filled in from the saved Default incomes ------

    private static HouseholdMember SeedMember(
        ApplicationDbContext db, string ownerId, string name, decimal defaultIncome, int order, bool archived = false)
    {
        var member = new HouseholdMember
        {
            OwnerId = ownerId, Name = name, NetMonthlyIncome = defaultIncome, DisplayOrder = order, IsArchived = archived,
        };
        db.HouseholdMembers.Add(member);
        db.SaveChanges();
        return member;
    }

    [Fact]
    public async Task Create_Blank_SeedsOneAttributedIncomeLinePerActivePersonWithADefault()
    {
        // Rule 28 calls the saved per-person figure "a helper for populating a new budget": a
        // blank month is where that happens. One line per active person with a default above
        // zero, in People-page order, attributed to them; nobody else gets a line.
        await using var db = NewContext();
        var robin = SeedMember(db, "user-1", "Robin", 2000m, order: 1);
        var alex = SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        SeedMember(db, "user-1", "Sam", 0m, order: 2);                     // no default → no line
        SeedMember(db, "user-1", "Old", 1500m, order: 3, archived: true);  // archived → no line
        SeedMember(db, "user-2", "Stranger", 9000m, order: 0);            // another household
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        var income = july.Categories.Should().ContainSingle().Subject;
        income.Kind.Should().Be("Income");
        income.Items.Select(i => (i.Name, i.PlannedAmount, i.MemberId, i.DisplayOrder)).Should().Equal(
            ("Alex", 3000m, (Guid?)alex.Id, 0),
            ("Robin", 2000m, (Guid?)robin.Id, 1));
        july.TotalIncome.Should().Be(5000m);

        // The seeded lines are ordinary income lines: the People/Allocation pool reads them
        // from the month (rule 28), not from the defaults they were copied from.
        var members = await db.HouseholdMembers.Where(m => m.OwnerId == "user-1").OrderBy(m => m.DisplayOrder).ToListAsync();
        var shares = await MemberIncome.SharesAsync(db, "user-1", 2026, 7, members, CancellationToken.None);
        shares.Income[alex.Id].Should().Be(3000m);
        shares.Income[robin.Id].Should().Be(2000m);
        shares.Unattributed.Should().Be(0m);
    }

    [Fact]
    public async Task Create_CopyWithNoPriorMonth_FallsBackToTheSeededBlank()
    {
        await using var db = NewContext();
        var alex = SeedMember(db, "user-1", "Alex", 3000m, order: 0);
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var june = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        june.Categories.Single(c => c.Kind == "Income").Items
            .Should().ContainSingle(i => i.Name == "Alex" && i.PlannedAmount == 3000m && i.MemberId == alex.Id);
    }

    [Fact]
    public async Task Create_CopyOrTemplate_KeepsItsOwnIncomeLines_NeverTheDefaults()
    {
        await using var db = NewContext();
        SeedJune(db, "user-1"); // Income: Pay 3000, whole-household
        SeedMember(db, "user-1", "Alex", 4000m, order: 0);
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        // A copy carries last month's income lines exactly; the default adds nothing.
        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);
        july.Categories.Single(c => c.Kind == "Income").Items
            .Select(i => (i.Name, i.PlannedAmount, i.MemberId))
            .Should().Equal(("Pay", 3000m, (Guid?)null));

        // A template month carries the template's own income lines, all at zero.
        var template = BudgetTemplates.All.First();
        var august = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 8, CopyFromPrevious: false, TemplateKey: template.Key), CancellationToken.None);
        var templateIncome = august.Categories.Single(c => c.Kind == "Income");
        templateIncome.Items.Select(i => i.Name).Should().Equal(template.Groups.Single(g => g.Kind == CategoryKind.Income).Lines);
        templateIncome.Items.Should().OnlyContain(i => i.PlannedAmount == 0m && i.MemberId == null);
    }
}
