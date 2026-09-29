using FluentAssertions;
using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Commands.SetBudgetItemBill;
using AllotJar.Application.Budgets.Commands.SetBudgetItemPaid;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Additional BILL-catalog coverage (docs/testing/cases/09-bills.md) for behaviour that
/// lives at the Application/domain layer and was previously un- or partly-automated:
/// changing a due day without disturbing paid, the paid-toggle both directions and its
/// [AllowLimited] role gate, the API looseness that lets a non-bill line be marked paid,
/// the validator's documented range message, and a cleared bill staying cleared across a
/// month copy.
///
/// Out of scope here (and NOT server-testable): the overdue / due-soon urgency
/// classification, the short-month due-day clamp (31 → 28/29 Feb) and the bills-summary
/// banner. The server DTO ships only the raw <c>DueDay</c>/<c>IsPaid</c> — every status is
/// computed in the browser (client/src/budgetModel.ts, exercised by
/// client/src/budgetModel.test.ts). Those cases (BILL-018..031) belong to the client unit
/// layer, not this project.
/// </summary>
public class BBillsCoverageTests
{
    private sealed class RoleStub(HouseholdRole? role) : ICurrentUser
    {
        public string? UserId => "user-1";
        public string? OwnerId => "user-1";
        public HouseholdRole? Role { get; } = role;
        public Guid? MemberId => null;
    }

    /// <summary>
    /// Seeds a single expense line inside a Housing group on the given month and returns it,
    /// so a test can drive the bill/paid handlers against a real, owned line.
    /// </summary>
    private static BudgetItem SeedLine(
        ApplicationDbContext db,
        string name = "Rent",
        decimal planned = 1100m,
        int? dueDay = null,
        bool isPaid = false,
        CategoryKind kind = CategoryKind.Expense,
        string ownerId = "user-1",
        int year = 2026,
        int month = 6)
    {
        var line = new BudgetItem { Name = name, PlannedAmount = planned, DueDay = dueDay, IsPaid = isPaid };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Housing", Kind = kind, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    // BILL-003 (change an existing bill's due day; IsPaid untouched) + BILL-001 invariant
    // "a due day carries no money": moving the due day must not reset paid nor move totals.
    [Fact]
    public async Task SetBill_ChangesTheDueDay_LeavesPaidUntouched_AndMovesNoMoney()
    {
        await using var db = NewContext();
        // A paid bill on day 20 — paid set true so we can prove *changing* the day (unlike
        // *clearing* it, BILL-005) does not un-pay it.
        var line = SeedLine(db, name: "Utilities", planned: 150m, dueDay: 20, isPaid: true);

        var handler = new SetBudgetItemBillCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new SetBudgetItemBillCommand(line.Id, 25), CancellationToken.None);

        var updated = dto.Categories.SelectMany(c => c.Items).Single(i => i.Name == "Utilities");
        updated.DueDay.Should().Be(25);      // the day moved
        updated.IsPaid.Should().BeTrue();    // ...but paid is left alone (only *clearing* un-pays)
        // A due day is not money: the planned/remaining totals are unaffected.
        dto.TotalPlanned.Should().Be(150m);
        dto.RemainingToBudget.Should().Be(-150m); // no income seeded, nothing else changed
    }

    // BILL-013 + BILL-014 (mark paid, then unpaid): the existing SetPaid test only proves the
    // true direction; this drives the full round-trip through the handler.
    [Fact]
    public async Task SetPaid_MarksPaid_ThenUnpaid()
    {
        await using var db = NewContext();
        var line = SeedLine(db, dueDay: 1);
        var handler = new SetBudgetItemPaidCommandHandler(db, new CurrentUserStub("user-1"));

        var paid = await handler.Handle(new SetBudgetItemPaidCommand(line.Id, true), CancellationToken.None);
        paid.Categories.SelectMany(c => c.Items).Single().IsPaid.Should().BeTrue();

        var unpaid = await handler.Handle(new SetBudgetItemPaidCommand(line.Id, false), CancellationToken.None);
        unpaid.Categories.SelectMany(c => c.Items).Single().IsPaid.Should().BeFalse();
    }

    // BILL-017 (regression / documented looseness): PUT items/{id}/paid does NOT verify the
    // line is a bill. Marking a due-day-less line paid succeeds (inert in the UI, but the
    // handler has no DueDay guard — this pins that documented behaviour).
    [Fact]
    public async Task SetPaid_SetsPaid_EvenOnANonBillLine()
    {
        await using var db = NewContext();
        var groceries = SeedLine(db, name: "Groceries", planned: 300m, dueDay: null);

        var handler = new SetBudgetItemPaidCommandHandler(db, new CurrentUserStub("user-1"));
        var dto = await handler.Handle(new SetBudgetItemPaidCommand(groceries.Id, true), CancellationToken.None);

        var line = dto.Categories.SelectMany(c => c.Items).Single(i => i.Name == "Groceries");
        line.IsPaid.Should().BeTrue(); // set despite DueDay == null — no server-side bill check
        line.DueDay.Should().BeNull();
    }

    // BILL-032 (companion to the existing carry+reset test): a line that is NOT a bill
    // (DueDay null — e.g. a bill that was cleared) copies forward as a plain non-bill line.
    // Clearing sticks across a month copy; nothing re-arms a due day.
    [Fact]
    public async Task CreateBudgetMonth_ClearedBill_StaysClearedAcrossCopy()
    {
        await using var db = NewContext();
        // May: a plain, due-day-less line (a bill that had been cleared).
        SeedLine(db, name: "Groceries", planned: 300m, dueDay: null, year: 2026, month: 5);

        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));
        await handler.Handle(new CreateBudgetMonthCommand(2026, 6, CopyFromPrevious: true), CancellationToken.None);

        var juneGroceries = await db.BudgetItems
            .Include(i => i.BudgetCategory).ThenInclude(c => c.BudgetMonth)
            .SingleAsync(i => i.Name == "Groceries" && i.BudgetCategory.BudgetMonth.Month == 6);
        juneGroceries.DueDay.Should().BeNull(); // still not a bill — clearing carried over
        juneGroceries.IsPaid.Should().BeFalse();
    }

    // BILL-033 (server side): SetBudgetItemPaidCommand is [AllowLimited] so a Limited login
    // may run it, while the undecorated SetBudgetItemBillCommand requires Admin+ and is
    // refused for Limited — driven through the real command types on the auth pipeline.
    [Fact]
    public async Task Limited_CanRun_SetPaid_ButNot_SetBill()
    {
        (await Ran(HouseholdRole.Limited, new SetBudgetItemPaidCommand(Guid.NewGuid(), true)))
            .Should().BeTrue();

        await Invoke(HouseholdRole.Limited, new SetBudgetItemBillCommand(Guid.NewGuid(), 10))
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    // BILL-034 (server side): ReadOnly (role 3) is refused every command — including the
    // [AllowLimited] paid toggle, which admits only Owner/Admin/Limited.
    [Fact]
    public async Task ReadOnly_Cannot_SetPaid_Or_SetBill()
    {
        await Invoke(HouseholdRole.ReadOnly, new SetBudgetItemPaidCommand(Guid.NewGuid(), true))
            .Should().ThrowAsync<ForbiddenAccessException>();

        await Invoke(HouseholdRole.ReadOnly, new SetBudgetItemBillCommand(Guid.NewGuid(), 10))
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    // --- auth-pipeline harness (mirrors AuthorizationBehaviourTests) ------------------------

    private static async Task<bool> Ran<TRequest>(HouseholdRole? role, TRequest request)
        where TRequest : notnull
    {
        var behaviour = new AuthorizationBehaviour<TRequest, BudgetMonthDto>(new RoleStub(role));
        var ran = false;
        RequestHandlerDelegate<BudgetMonthDto> next = _ => { ran = true; return Task.FromResult(new BudgetMonthDto()); };
        await behaviour.Handle(request, next, CancellationToken.None);
        return ran;
    }

    private static Func<Task> Invoke<TRequest>(HouseholdRole? role, TRequest request)
        where TRequest : notnull
    {
        var behaviour = new AuthorizationBehaviour<TRequest, BudgetMonthDto>(new RoleStub(role));
        RequestHandlerDelegate<BudgetMonthDto> next = _ => Task.FromResult(new BudgetMonthDto());
        return () => behaviour.Handle(request, next, CancellationToken.None);
    }
}
