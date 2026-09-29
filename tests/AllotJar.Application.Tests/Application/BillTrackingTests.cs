using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Commands.SetBudgetItemBill;
using AllotJar.Application.Budgets.Commands.SetBudgetItemPaid;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Bill tracking: a line can carry a due day (making it a bill) and a per-month
/// paid status. Due days recur across months; paid resets each month.
/// </summary>
public class BillTrackingTests
{
    private static BudgetItem SeedRent(ApplicationDbContext db, string ownerId = "user-1", int year = 2026, int month = 6)
    {
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 1100m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Housing", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { rent } },
            },
        });
        db.SaveChanges();
        return rent;
    }

    [Fact]
    public async Task SetBill_MakesTheLineABillDueOnTheGivenDay()
    {
        await using var db = NewContext();
        var rent = SeedRent(db);

        var handler = new SetBudgetItemBillCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new SetBudgetItemBillCommand(rent.Id, 15), CancellationToken.None);

        var line = dto.Categories.Single().Items.Single();
        line.DueDay.Should().Be(15);
        line.IsPaid.Should().BeFalse();
    }

    [Fact]
    public async Task ClearingTheDueDay_AlsoResetsPaid()
    {
        await using var db = NewContext();
        var rent = SeedRent(db);
        rent.DueDay = 15;
        rent.IsPaid = true;
        await db.SaveChangesAsync();

        var handler = new SetBudgetItemBillCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new SetBudgetItemBillCommand(rent.Id, null), CancellationToken.None);

        var line = dto.Categories.Single().Items.Single();
        line.DueDay.Should().BeNull();
        line.IsPaid.Should().BeFalse();
    }

    [Fact]
    public async Task SetBill_Throws_WhenTheLineIsNotOwned()
    {
        await using var db = NewContext();
        var rent = SeedRent(db);

        var handler = new SetBudgetItemBillCommandHandler(db, new CurrentUserStub("attacker"));
        var act = () => handler.Handle(new SetBudgetItemBillCommand(rent.Id, 10), CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(32, false)]
    [InlineData(1, true)]
    [InlineData(31, true)]
    [InlineData(null, true)] // null clears the bill — valid
    public void Validator_ChecksDueDayRange(int? dueDay, bool expectedValid)
    {
        // BILL-012: an out-of-range day is refused with the documented message.
        var result = new SetBudgetItemBillCommandValidator()
            .Validate(new SetBudgetItemBillCommand(Guid.NewGuid(), dueDay));

        result.IsValid.Should().Be(expectedValid);
        if (!expectedValid)
            result.Errors.Should().ContainSingle()
                .Which.ErrorMessage.Should().Be("A due day must be between 1 and 31.");
    }

    [Fact]
    public async Task CreateBudgetMonth_CarriesTheDueDayButResetsPaid()
    {
        await using var db = NewContext();
        var rent = SeedRent(db, year: 2026, month: 5);
        rent.DueDay = 15;
        rent.IsPaid = true; // paid in May
        await db.SaveChangesAsync();

        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneRent = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.Name == "Rent" && i.BudgetCategory.BudgetMonth.Month == 6);
        juneRent.DueDay.Should().Be(15);   // the bill recurs
        juneRent.IsPaid.Should().BeFalse(); // but starts the month unpaid
    }
}
