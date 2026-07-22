using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Commands.SetBudgetItemMember;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Income-line member attribution (the budget-side half of per-person income): only income
/// lines carry a member, the member must be this household's and active, month-copy rolls
/// the attribution forward (dropping archived people), and the DTO round-trips it.
/// </summary>
public class BudgetItemMemberTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-item-member-{Guid.NewGuid()}")
            .Options);

    private sealed record Seeded(Guid IncomeCategoryId, Guid ExpenseCategoryId, Guid IncomeLineId, HouseholdMember Alex, HouseholdMember Robin);

    private static Seeded Seed(ApplicationDbContext db, string ownerId = "user-1")
    {
        var pay = new BudgetItem { Name = "Alex — Salary", PlannedAmount = 3000m };
        var income = new BudgetCategory
        {
            Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { pay },
        };
        var housing = new BudgetCategory
        {
            Name = "Housing", Items = new List<BudgetItem> { new() { Name = "Rent", PlannedAmount = 1000m } },
        };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId, Year = 2026, Month = 6,
            Categories = new List<BudgetCategory> { income, housing },
        });
        var alex = new HouseholdMember { OwnerId = ownerId, Name = "Alex", NetMonthlyIncome = 3000m };
        var robin = new HouseholdMember { OwnerId = ownerId, Name = "Robin", NetMonthlyIncome = 2000m };
        db.HouseholdMembers.AddRange(alex, robin);
        db.SaveChanges();
        return new Seeded(income.Id, housing.Id, pay.Id, alex, robin);
    }

    [Fact]
    public async Task SetMember_AttributesAndClears_AndDtoRoundTrips()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new SetBudgetItemMemberCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, s.Alex.Id), CancellationToken.None);
        dto.Categories.Single(c => c.Kind == "Income").Items.Single().MemberId.Should().Be(s.Alex.Id);

        var cleared = await handler.Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, null), CancellationToken.None);
        cleared.Categories.Single(c => c.Kind == "Income").Items.Single().MemberId.Should().BeNull();
    }

    [Fact]
    public async Task SetMember_RejectsNonIncomeLines_AndForeignOrArchivedMembers()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var rentId = (await db.BudgetItems.SingleAsync(i => i.Name == "Rent")).Id;
        var handler = new SetBudgetItemMemberCommandHandler(db, new CurrentUserStub("user-1"));

        var expense = () => handler.Handle(new SetBudgetItemMemberCommand(rentId, s.Alex.Id), CancellationToken.None);
        (await expense.Should().ThrowAsync<ValidationException>())
            .Which.Errors["MemberId"].Should().Contain("Only income lines can be assigned to a person.");

        var foreignMember = new HouseholdMember { OwnerId = "someone-else", Name = "Mallory" };
        db.HouseholdMembers.Add(foreignMember);
        await db.SaveChangesAsync();
        var foreign = () => handler.Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, foreignMember.Id), CancellationToken.None);
        await foreign.Should().ThrowAsync<NotFoundException>();

        s.Robin.IsArchived = true;
        await db.SaveChangesAsync();
        var archived = () => handler.Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, s.Robin.Id), CancellationToken.None);
        await archived.Should().ThrowAsync<NotFoundException>();
    }

    [Fact]
    public async Task AddItem_WithMember_StampsIt_AndRejectsExpenseTargets()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var dto = await handler.Handle(
            new AddBudgetItemCommand(s.IncomeCategoryId, "Robin — Salary", 2000m, s.Robin.Id), CancellationToken.None);
        dto.Categories.Single(c => c.Kind == "Income")
            .Items.Single(i => i.Name == "Robin — Salary").MemberId.Should().Be(s.Robin.Id);

        var expense = () => handler.Handle(
            new AddBudgetItemCommand(s.ExpenseCategoryId, "Groceries", 100m, s.Robin.Id), CancellationToken.None);
        await expense.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task MonthCopy_CarriesAttribution_ButDropsArchivedMembers()
    {
        await using var db = NewContext();
        var s = Seed(db);
        var setter = new SetBudgetItemMemberCommandHandler(db, new CurrentUserStub("user-1"));
        await setter.Handle(new SetBudgetItemMemberCommand(s.IncomeLineId, s.Alex.Id), CancellationToken.None);
        var add = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));
        await add.Handle(new AddBudgetItemCommand(s.IncomeCategoryId, "Robin — Salary", 2000m, s.Robin.Id), CancellationToken.None);

        // Robin leaves the household before the next month is created.
        s.Robin.IsArchived = true;
        await db.SaveChangesAsync();

        var create = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        var next = await create.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        var incomeItems = next.Categories.Single(c => c.Kind == "Income").Items;
        incomeItems.Single(i => i.Name == "Alex — Salary").MemberId.Should().Be(s.Alex.Id);
        // The archived person's line copies as whole-household, not attributed to someone gone.
        incomeItems.Single(i => i.Name == "Robin — Salary").MemberId.Should().BeNull();
    }
}
