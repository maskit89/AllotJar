using FluentAssertions;
using MediatR;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Budgets.Commands.AddBudgetCategory;
using AllotJar.Application.Budgets.Commands.AddBudgetItem;
using AllotJar.Application.Budgets.Commands.DeleteBudgetCategory;
using AllotJar.Application.Budgets.Commands.DeleteBudgetItem;
using AllotJar.Application.Budgets.Commands.RenameBudgetCategory;
using AllotJar.Application.Budgets.Commands.ReorderBudgetCategories;
using AllotJar.Application.Budgets.Commands.ReorderBudgetItems;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Categories &amp; budget-lines coverage (catalog prefix CAT,
/// docs/testing/cases/08-categories-budget-lines.md). Automates the P0 plus the
/// cheap P1/P2/P3 cases whose behaviour lives at the Application/domain layer and
/// was previously "No" or "Partial", without duplicating what
/// BudgetCategoryCrudHandlerTests / BudgetItemCrudHandlerTests / JarBudgetLinkTests /
/// ReorderBudget*Tests / SavingsTests / AuthorizationBehaviourTests already assert:
///
///  - CAT-007  group-name 120/121 length boundary on the add-category validator
///  - CAT-008/010  add-category trims surrounding whitespace and stores unicode verbatim
///  - CAT-009  duplicate group names are allowed (no uniqueness) and get the next per-kind order
///  - CAT-015  the Income group is renamable via the API and stays Kind=Income, still first
///  - CAT-021  deleting a group keeps its lines' assigned transactions (history is not destroyed)
///  - CAT-023  deleting a Savings group leaves the backing jar row intact
///  - CAT-033  add-line stores unicode verbatim and allows duplicate line names within a group
///  - CAT-039  the line-rename (update) endpoint has NO empty-name guard and does NOT trim;
///             a null name is a planned-only edit that keeps the existing name
///  - CAT-043  deleting a line keeps its assigned transactions
///  - CAT-044  deleting a Savings line leaves the backing jar row intact
///  - CAT-048  a group/line reorder persists and round-trips through GetBudgetMonth (Income first,
///             then each kind by the manually set DisplayOrder; items by DisplayOrder)
///  - CAT-050  the first expense group added to a blank month gets DisplayOrder 0; Income stays first
///  - CAT-051  every structural budget command is gated for Limited and ReadOnly (Admin may run them)
///
/// Deferred elsewhere: the SetNull half of CAT-021/CAT-043 (a kept transaction's
/// BudgetItemId becoming null) is a database-enforced FK behaviour that EF InMemory
/// cannot reproduce — it lives in the SQL integration layer alongside the SavingsId
/// FK (CAT-035, already covered by tests/AllotJar.IntegrationTests/SavingsForeignKeyTests.cs
/// and, at this layer, JarBudgetLinkTests.AddItem_ToSavingsGroup_CreatesTheBackingJar).
/// All optimistic-UI rollback, inline-confirm, Escape/blur and error-strip cases
/// (CAT-003/004/011/014/016/019/025/037/041/045-UI) are client-only and stay in the
/// Vitest DashboardPage suite.
/// </summary>
public class CCategoriesLinesCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private sealed class RoleStub(HouseholdRole? role) : ICurrentUser
    {
        public string? UserId => "user-1";
        public string? OwnerId => "user-1";
        public HouseholdRole? Role { get; } = role;
        public Guid? MemberId => null;
    }

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-cat-cov-{Guid.NewGuid()}")
            .Options);

    // Income(Salary 2000) + Housing(Rent 900, Utilities 150) under one owner-scoped month.
    private sealed record Seeded(
        Guid MonthId, Guid IncomeId, Guid HousingId, Guid RentId, Guid UtilitiesId);

    private static Seeded Seed(ApplicationDbContext db, string ownerId, int year = 2026, int month = 7)
    {
        var income = new BudgetCategory
        {
            Name = "Income",
            Kind = CategoryKind.Income,
            DisplayOrder = 0,
            Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 2000m, DisplayOrder = 0 } },
        };
        var rent = new BudgetItem { Name = "Rent", PlannedAmount = 900m, DisplayOrder = 0 };
        var utilities = new BudgetItem { Name = "Utilities", PlannedAmount = 150m, DisplayOrder = 1 };
        var housing = new BudgetCategory
        {
            Name = "Housing",
            Kind = CategoryKind.Expense,
            DisplayOrder = 0,
            Items = new List<BudgetItem> { rent, utilities },
        };
        var budget = new BudgetMonth
        {
            OwnerId = ownerId,
            Year = year,
            Month = month,
            Categories = new List<BudgetCategory> { income, housing },
        };
        db.BudgetMonths.Add(budget);
        db.SaveChanges();
        return new Seeded(budget.Id, income.Id, housing.Id, rent.Id, utilities.Id);
    }

    // ---- Category-group creation: validation & name handling ------------------

    // CAT-007 — MaximumLength(120) is inclusive: a 120-char group name validates, 121 fails on Name.
    [Fact]
    public void AddCategoryValidator_AcceptsNameAt120_RejectsAt121()
    {
        var validator = new AddBudgetCategoryCommandValidator();

        validator.Validate(new AddBudgetCategoryCommand(Guid.NewGuid(), new string('x', 120)))
            .IsValid.Should().BeTrue();

        var over = validator.Validate(new AddBudgetCategoryCommand(Guid.NewGuid(), new string('x', 121)));
        over.IsValid.Should().BeFalse();
        over.Errors.Should().Contain(e => e.PropertyName == nameof(AddBudgetCategoryCommand.Name));
    }

    // CAT-008 / CAT-010 — the handler only .Trim()s: surrounding whitespace is stripped but the
    // unicode/emoji body is stored verbatim (no transliteration/normalisation).
    [Fact]
    public async Task AddCategory_TrimsSurroundingWhitespace_AndStoresUnicodeVerbatim()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetCategoryCommand(s.MonthId, "  Ahorros 🏦 — Straße/日本語  "), CancellationToken.None);

        result.Categories.Should().Contain(c => c.Name == "Ahorros 🏦 — Straße/日本語");
    }

    // CAT-009 — there is no uniqueness constraint on group names: a second "Housing" is a distinct
    // group with the next per-kind DisplayOrder (Housing already occupies expense order 0).
    [Fact]
    public async Task AddCategory_AllowsDuplicateGroupNames_WithNextDisplayOrder()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetCategoryCommand(s.MonthId, "Housing"), CancellationToken.None);

        var housings = result.Categories.Where(c => c.Name == "Housing").ToList();
        housings.Should().HaveCount(2);
        housings.Select(c => c.Id).Distinct().Should().HaveCount(2);
        housings.Select(c => c.DisplayOrder).OrderBy(o => o).Should().Equal(0, 1);
    }

    // CAT-050 — the first expense group added to a blank month (only the seeded Income group, no
    // expenses) gets DisplayOrder 0, and the Income group still renders first.
    [Fact]
    public async Task AddFirstExpenseGroup_ToBlankMonth_GetsDisplayOrderZero_IncomeStaysFirst()
    {
        await using var db = NewContext();
        var income = new BudgetCategory { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 };
        var blank = new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 7,
            Categories = new List<BudgetCategory> { income },
        };
        db.BudgetMonths.Add(blank);
        await db.SaveChangesAsync();
        var handler = new AddBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new AddBudgetCategoryCommand(blank.Id, "Bills"), CancellationToken.None);

        var bills = result.Categories.Single(c => c.Name == "Bills");
        bills.Kind.Should().Be("Expense");
        bills.DisplayOrder.Should().Be(0);       // first of its kind
        result.Categories[0].Kind.Should().Be("Income"); // Income still first
    }

    // ---- Category-group rename: the Income asymmetry --------------------------

    // CAT-015 — there is no UI affordance to rename the Income group, but the API has no kind check,
    // so a direct rename succeeds; the group stays Kind=Income and still renders first.
    [Fact]
    public async Task RenameIncomeGroup_SucceedsViaApi_AndStaysIncomeKindFirst()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new RenameBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new RenameBudgetCategoryCommand(s.IncomeId, "Earnings"), CancellationToken.None);

        var income = result.Categories.Single(c => c.Kind == "Income");
        income.Id.Should().Be(s.IncomeId);
        income.Name.Should().Be("Earnings");
        result.Categories[0].Kind.Should().Be("Income"); // ordering unchanged by the rename
    }

    // ---- Category-group deletion: transactions & jars survive -----------------

    // CAT-021 — deleting a group removes the group + its lines but NEVER deletes their assigned
    // transactions (budget history is preserved). The kept transaction's BudgetItemId becoming
    // null is the DB-enforced SetNull half, verified in the SQL integration layer, not here.
    [Fact]
    public async Task DeleteGroup_RemovesGroupAndLines_ButKeepsAssignedTransactions()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            BudgetItemId = s.RentId,
            Amount = 900m,
            Type = TransactionType.Expense,
            Currency = CurrencyCode.Eur,
            Date = new DateOnly(2026, 7, 3),
        });
        await db.SaveChangesAsync();
        var handler = new DeleteBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new DeleteBudgetCategoryCommand(s.HousingId), CancellationToken.None);

        result.Categories.Should().NotContain(c => c.Id == s.HousingId);
        (await db.BudgetItems.CountAsync(i => i.Id == s.RentId)).Should().Be(0); // line gone
        db.Transactions.Should().ContainSingle();                                // the €900 tx kept
    }

    // CAT-023 — deleting a Savings group removes the group + its savings line but leaves the backing
    // jar row (SavingsId FK is SetNull; the Jars row is never touched by a category delete).
    [Fact]
    public async Task DeleteSavingsGroup_LeavesTheBackingJar()
    {
        await using var db = NewContext();
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Emergency Fund",
            Kind = JarKind.Goal, Accrual = AccrualMethod.TargetByDate,
        };
        var line = new BudgetItem { Name = "Emergency Fund", PlannedAmount = 100m, SavingsId = jar.Id };
        var savings = new BudgetCategory
        {
            Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
            Items = new List<BudgetItem> { line },
        };
        var month = new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 7,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
                savings,
            },
        };
        db.Jars.Add(jar);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();
        var handler = new DeleteBudgetCategoryCommandHandler(db, new CurrentUserStub("user-1"));

        var result = await handler.Handle(
            new DeleteBudgetCategoryCommand(savings.Id), CancellationToken.None);

        result.Categories.Should().NotContain(c => c.Kind == "Savings");
        db.Jars.Should().ContainSingle(j => j.Id == jar.Id && !j.IsArchived);
    }

    // ---- Budget-line creation: name handling ----------------------------------

    // CAT-033 — a line name is only .Trim()med (unicode/emoji stored verbatim), and duplicate line
    // names within the same group are allowed (no uniqueness), each getting a contiguous DisplayOrder.
    [Fact]
    public async Task AddLine_StoresUnicodeVerbatim_AndAllowsDuplicateNames()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new AddBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new AddBudgetItemCommand(s.HousingId, "  Café ☕ Straße  "), CancellationToken.None);
        var result = await handler.Handle(new AddBudgetItemCommand(s.HousingId, "Rent"), CancellationToken.None);

        var housing = result.Categories.Single(c => c.Id == s.HousingId);
        housing.Items.Should().Contain(i => i.Name == "Café ☕ Straße");   // trimmed, otherwise verbatim
        housing.Items.Where(i => i.Name == "Rent").Should().HaveCount(2);  // duplicate allowed
        // Rent(0), Utilities(1), Café(2), Rent(3) — contiguous, no re-sort.
        housing.Items.Select(i => i.DisplayOrder).OrderBy(o => o).Should().Equal(0, 1, 2, 3);
    }

    // ---- Budget-line rename (update) endpoint: the validation gap --------------

    // CAT-039 — UpdateBudgetItemCommand has NO NotEmpty on Name (only MaximumLength when non-null),
    // so a whitespace-only name passes the validator. This is the documented server-side gap the
    // UI shields; the assertion locks the current (intended-asymmetric) behaviour, not a bug.
    [Fact]
    public void UpdateItemValidator_HasNoEmptyNameGuard_WhitespaceNamePasses()
    {
        var validator = new UpdateBudgetItemCommandValidator();

        validator.Validate(new UpdateBudgetItemCommand(Guid.NewGuid(), 900m, "   "))
            .IsValid.Should().BeTrue();

        // The only Name rule is the 120-char cap, and it only fires when Name is non-null.
        validator.Validate(new UpdateBudgetItemCommand(Guid.NewGuid(), 900m, new string('x', 121)))
            .IsValid.Should().BeFalse();
    }

    // CAT-039 — the handler assigns item.Name = request.Name WITHOUT trimming (padding kept), while a
    // null Name is a planned-only update that leaves the existing name untouched.
    [Fact]
    public async Task UpdateItem_StoresNameUntrimmed_AndNullNameKeepsExistingName()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        var handler = new UpdateBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        // Untrimmed padding is persisted verbatim (asymmetric with add-line's Trim()).
        await handler.Handle(
            new UpdateBudgetItemCommand(s.UtilitiesId, 150m, "  Power  "), CancellationToken.None);
        (await db.BudgetItems.AsNoTracking().SingleAsync(i => i.Id == s.UtilitiesId))
            .Name.Should().Be("  Power  ");

        // A null name is a planned-only edit: the name stays, the planned amount changes.
        var result = await handler.Handle(
            new UpdateBudgetItemCommand(s.RentId, 950m, null), CancellationToken.None);
        var rent = result.Categories.SelectMany(c => c.Items).Single(i => i.Id == s.RentId);
        rent.Name.Should().Be("Rent");
        rent.PlannedAmount.Should().Be(950m);
    }

    // ---- Budget-line deletion: transactions & jars survive --------------------

    // CAT-043 — deleting a line removes the line but keeps its assigned transactions (spending
    // history is never destroyed). The BudgetItemId→null SetNull half is a SQL-layer concern.
    [Fact]
    public async Task DeleteLine_RemovesLine_ButKeepsAssignedTransactions()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1",
            BudgetItemId = s.RentId,
            Amount = 900m,
            Type = TransactionType.Expense,
            Currency = CurrencyCode.Eur,
            Date = new DateOnly(2026, 7, 3),
        });
        await db.SaveChangesAsync();
        var handler = new DeleteBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        await handler.Handle(new DeleteBudgetItemCommand(s.RentId), CancellationToken.None);

        (await db.BudgetItems.CountAsync(i => i.Id == s.RentId)).Should().Be(0); // line gone
        db.Transactions.Should().ContainSingle();                                // the €900 tx kept
    }

    // CAT-044 (W04, rule 60) — a Savings line is a jar's monthly contribution: it cannot be
    // deleted from the month. The handler refuses and points at skipping the month or archiving
    // the jar; the line and its jar are untouched.
    [Fact]
    public async Task DeleteSavingsLine_IsRefused_TheLineAndItsJarStay()
    {
        await using var db = NewContext();
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Emergency Fund",
            Kind = JarKind.Goal, Accrual = AccrualMethod.TargetByDate,
        };
        var line = new BudgetItem { Name = "Emergency Fund", PlannedAmount = 100m, SavingsId = jar.Id, DisplayOrder = 0 };
        var savings = new BudgetCategory
        {
            Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0,
            Items = new List<BudgetItem> { line },
        };
        var month = new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 7,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
                savings,
            },
        };
        db.Jars.Add(jar);
        db.BudgetMonths.Add(month);
        await db.SaveChangesAsync();
        var handler = new DeleteBudgetItemCommandHandler(db, new CurrentUserStub("user-1"));

        var act = () => handler.Handle(new DeleteBudgetItemCommand(line.Id), CancellationToken.None);

        var ex = await act.Should().ThrowAsync<ValidationException>();
        ex.Which.Errors.Values.SelectMany(v => v).Single().Should().Contain("Skip this month's contribution, or archive the jar");
        (await db.BudgetItems.CountAsync(i => i.Id == line.Id)).Should().Be(1); // line stays
        db.Jars.Should().ContainSingle(j => j.Id == jar.Id && !j.IsArchived);   // jar stays active
    }

    // ---- Reorder persistence round-trip ---------------------------------------

    // CAT-048 — a group reorder AND a line reorder both persist as DisplayOrder and round-trip
    // through GetBudgetMonth: categories come back Income→Expense→Savings then by the manually set
    // order, items by their manually set order — no drift, no re-sort by name/id.
    [Fact]
    public async Task Reorder_GroupsAndLines_PersistsAndRoundTripsThroughGet()
    {
        await using var db = NewContext();
        var s = Seed(db, "user-1");
        // Add a second expense group so there is something to reorder against Housing.
        var subs = new BudgetCategory
        {
            BudgetMonthId = s.MonthId, Name = "Subscriptions", Kind = CategoryKind.Expense, DisplayOrder = 1,
        };
        db.BudgetCategories.Add(subs);
        await db.SaveChangesAsync();
        var user = new CurrentUserStub("user-1");

        // Reorder expense groups: Subscriptions before Housing.
        await new ReorderBudgetCategoriesCommandHandler(db, user).Handle(
            new ReorderBudgetCategoriesCommand(s.MonthId, new[] { subs.Id, s.HousingId }),
            CancellationToken.None);
        // Reorder Housing's lines: Utilities before Rent.
        await new ReorderBudgetItemsCommandHandler(db, user).Handle(
            new ReorderBudgetItemsCommand(s.HousingId, new[] { s.UtilitiesId, s.RentId }),
            CancellationToken.None);

        // Fresh GET — the projection is the source of truth the dashboard reloads from.
        var month = await new GetBudgetMonthQueryHandler(db, user).Handle(
            new GetBudgetMonthQuery(2026, 7), CancellationToken.None);

        month.Categories.Select(c => c.Name).Should().Equal("Income", "Subscriptions", "Housing");
        month.Categories.Single(c => c.Id == s.HousingId).Items.Select(i => i.Name)
            .Should().Equal("Utilities", "Rent");
    }

    // ---- Role gating on structural commands (CAT-051) -------------------------

    // CAT-051 — none of the structural budget commands is [AllowLimited], so the MediatR
    // AuthorizationBehaviour refuses them for Limited and ReadOnly logins (Admin may run them).
    // Only the bill-paid toggle (out of scope here) is Limited-permitted.
    [Fact]
    public async Task StructuralBudgetCommands_AreGated_ForLimitedAndReadOnly()
    {
        // One representative instance of each structural command; the gate inspects only the
        // request type's attributes and the caller's role, never touching a handler.
        await AssertGated(new AddBudgetCategoryCommand(Guid.NewGuid(), "X"));
        await AssertGated(new RenameBudgetCategoryCommand(Guid.NewGuid(), "X"));
        await AssertGated(new DeleteBudgetCategoryCommand(Guid.NewGuid()));
        await AssertGated(new AddBudgetItemCommand(Guid.NewGuid(), "X"));
        await AssertGated(new UpdateBudgetItemCommand(Guid.NewGuid(), 0m, "X"));
        await AssertGated(new DeleteBudgetItemCommand(Guid.NewGuid()));
        await AssertGated(new ReorderBudgetCategoriesCommand(Guid.NewGuid(), Array.Empty<Guid>()));
        await AssertGated(new ReorderBudgetItemsCommand(Guid.NewGuid(), Array.Empty<Guid>()));
    }

    // Limited + ReadOnly are refused; Admin passes the gate (proving the refusal is the role rule,
    // not the command being owner-only or otherwise universally blocked).
    private static async Task AssertGated<TRequest>(TRequest request)
        where TRequest : notnull
    {
        await RunGate(HouseholdRole.Limited, request)
            .Should().ThrowAsync<ForbiddenAccessException>();
        await RunGate(HouseholdRole.ReadOnly, request)
            .Should().ThrowAsync<ForbiddenAccessException>();
        await RunGate(HouseholdRole.Admin, request)
            .Should().NotThrowAsync();
    }

    private static Func<Task> RunGate<TRequest>(HouseholdRole role, TRequest request)
        where TRequest : notnull
    {
        var behaviour = new AuthorizationBehaviour<TRequest, BudgetMonthDto>(new RoleStub(role));
        RequestHandlerDelegate<BudgetMonthDto> next = _ => Task.FromResult(new BudgetMonthDto());
        return () => behaviour.Handle(request, next, CancellationToken.None);
    }
}
