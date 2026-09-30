using FluentAssertions;
using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Behaviours;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Month-lifecycle coverage (catalog prefix BUDG, docs/testing/cases/07-month-lifecycle.md).
/// Fills the P0/cheap-P1 gaps left by CreateBudgetMonthTests / JarBudgetLinkTests /
/// BudgetTemplatesTests / BillTrackingTests: the over-budgeted jar-owning empty month
/// (PR #172), opening-balance-inclusive as-of seeding, the default/inherited BaseCurrency,
/// template-key precedence/matching edge cases, day-31 due-day fidelity, category-order
/// fidelity on copy, the Year/Month create validator, and the role gate on the create command.
/// All assertions are at the Application/domain layer (EF Core InMemory) to match the suite.
/// </summary>
public class BMonthLifecycleCoverageTests
{
    /// <summary>A stub that also varies the household role, for the create-command gate.</summary>
    private sealed class RoleUserStub(HouseholdRole? role) : ICurrentUser
    {
        public string? UserId => "user-1";
        public string? OwnerId => "user-1";
        public HouseholdRole? Role { get; } = role;
        public Guid? MemberId => null;
    }

    // BUDG-028 / BUDG-056: a blank (or first-ever) month for a household that already owns
    // an active, seedable jar is born OVER-BUDGETED — the jar-append step adds an
    // accrual-planned savings line, so income 0 + planned > 0 → negative remaining and
    // NOT balanced (PR #172: empty ≠ balanced). The existing JarBudgetLinkTests only checks
    // the appended group/line name; here we pin the hero-driving figures end-to-end.
    [Fact]
    public async Task Create_Blank_ForJarOwningHousehold_IsBornOverBudgeted()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        // Holiday: Goal, target 1,200 due 1 July 2027 (twelve contribution months from July 2026,
        // rule 12), nothing allocated → seedable.
        db.Jars.Add(new Jar
        {
            OwnerId = "user-1", Name = "Holiday", Kind = JarKind.Goal,
            Accrual = AccrualMethod.TargetByDate, TargetAmount = 1200m,
            TargetDate = new DateOnly(2027, 7, 1),
            FundingAccountId = account.Id,
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        // Append step created a Savings group with the Holiday line planned 1,200 ÷ 12 months.
        var savings = july.Categories.Single(c => c.Kind == "Savings");
        savings.Items.Single(i => i.Name == "Holiday").PlannedAmount.Should().Be(100m);

        july.TotalIncome.Should().Be(0m);          // no income planned yet
        july.TotalPlanned.Should().Be(100m);       // the appended jar contribution
        july.RemainingToBudget.Should().Be(-100m); // over-budgeted, not the neutral empty state
        july.IsBalanced.Should().BeFalse();        // income == 0 ⇒ never the gold balanced badge
    }

    // BUDG-037: the as-of seed folds the jar's actual ledger balance (its allocation as of the
    // day before the month, rule 48) into the balance, so a jar already holding 300 needs only
    // (1,200 − 300) ÷ 12 months this month. This exercises the handler path.
    [Fact]
    public async Task Create_SeedsAppendedJarLine_FoldingInTheJarsAllocatedBalance()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, "user-1");
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Holiday", Kind = JarKind.Goal,
            Accrual = AccrualMethod.TargetByDate, TargetAmount = 1200m,
            TargetDate = new DateOnly(2027, 7, 1),
            FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 300m, new DateOnly(2026, 6, 1));
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);

        // (1,200 − 300) ÷ 12 = 75.00 — the allocated money counts toward the as-of balance.
        var line = july.Categories.Single(c => c.Kind == "Savings").Items.Single(i => i.Name == "Holiday");
        line.PlannedAmount.Should().Be(75m);
    }

    // BUDG-011: with no previous month to inherit from, a first-ever month defaults its
    // BaseCurrency to EUR — for both the blank path and a template path. (The copy path's
    // "inherit the previous month's currency" half is already covered by CreateBudgetMonthTests.)
    [Fact]
    public async Task Create_FirstEverMonth_DefaultsBaseCurrencyToEur()
    {
        await using var blankDb = NewContext();
        var blank = await new CreateBudgetMonthCommandHandler(blankDb, new CurrentUserStub("user-1"))
            .Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false), CancellationToken.None);
        blank.BaseCurrency.Should().Be("EUR");

        await using var templateDb = NewContext();
        var fromTemplate = await new CreateBudgetMonthCommandHandler(templateDb, new CurrentUserStub("user-2"))
            .Handle(new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: "essentials"),
                CancellationToken.None);
        fromTemplate.BaseCurrency.Should().Be("EUR");
    }

    // BUDG-024: BudgetTemplates.Find matches the key OrdinalIgnoreCase, so an upper-cased
    // key still resolves the template (only real keys reach the API, but the API contract
    // must not 400 on casing).
    [Fact]
    public async Task Create_FromTemplate_MatchesTheKeyCaseInsensitively()
    {
        await using var db = NewContext();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: false, TemplateKey: "ESSENTIALS"),
            CancellationToken.None);

        // Essentials-specific groups prove the upper-cased key resolved (no ValidationException).
        july.Categories.Should().Contain(c => c.Name == "Housing" && c.Kind == "Expense");
        july.Categories.Should().Contain(c => c.Name == "Transport" && c.Kind == "Expense");
    }

    // BUDG-026: a whitespace-only template key is treated as "no template" (Find returns null
    // WITHOUT the unknown-template error), so the request falls through to copy-from-previous
    // rather than 400-ing or silently going blank.
    [Fact]
    public async Task Create_WithWhitespaceTemplateKey_FallsThroughToCopyFromPrevious()
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
                    Items = new List<BudgetItem> { new() { Name = "Pay", PlannedAmount = 2500m } },
                },
                new()
                {
                    Name = "Housing", Kind = CategoryKind.Expense, DisplayOrder = 1,
                    Items = new List<BudgetItem> { new() { Name = "Rent", PlannedAmount = 1000m } },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true, TemplateKey: "   "),
            CancellationToken.None);

        // Copied June's structure — not blank (would be Income-only) and not a 400.
        july.Categories.Should().Contain(c => c.Name == "Housing");
        july.Categories.Single(c => c.Name == "Housing").Items.Single(i => i.Name == "Rent")
            .PlannedAmount.Should().Be(1000m);
    }

    // BUDG-009: copy stores a day-31 due day verbatim — clamping to a short month is a
    // display concern (owned by the client), so the persisted DueDay is never truncated
    // and re-copies as 31.
    [Fact]
    public async Task Create_Copy_CarriesADay31DueDayVerbatim()
    {
        await using var db = NewContext();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2027, Month = 1, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Housing", Kind = CategoryKind.Expense, DisplayOrder = 0,
                    Items = new List<BudgetItem> { new() { Name = "Rent", PlannedAmount = 1000m, DueDay = 31 } },
                },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        // Copy January 2027 into February 2027 (a 28-day month).
        var february = await handler.Handle(
            new CreateBudgetMonthCommand(2027, 2, CopyFromPrevious: true), CancellationToken.None);

        february.Categories.Single(c => c.Name == "Housing").Items.Single(i => i.Name == "Rent")
            .DueDay.Should().Be(31); // stored value not truncated to 28
    }

    // BUDG-012: copy carries each category's DisplayOrder (and Kind), so Housing (order 1)
    // still renders before Food (order 2). The DTO orders by kind then DisplayOrder.
    [Fact]
    public async Task Create_Copy_PreservesCategoryDisplayOrderAndPerKindOrdering()
    {
        await using var db = NewContext();
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = "user-1", Year = 2026, Month = 6, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0 },
                new() { Name = "Housing", Kind = CategoryKind.Expense, DisplayOrder = 1 },
                new() { Name = "Food", Kind = CategoryKind.Expense, DisplayOrder = 2 },
            },
        });
        await db.SaveChangesAsync();
        var handler = new CreateBudgetMonthCommandHandler(db, new CurrentUserStub("user-1"));

        var july = await handler.Handle(
            new CreateBudgetMonthCommand(2026, 7, CopyFromPrevious: true), CancellationToken.None);

        july.Categories.Single(c => c.Name == "Housing").DisplayOrder.Should().Be(1);
        july.Categories.Single(c => c.Name == "Food").DisplayOrder.Should().Be(2);
        // Rendered order: Income first, then Housing before Food (DisplayOrder within the kind).
        july.Categories.Select(c => c.Name).Should().ContainInOrder("Income", "Housing", "Food");
    }

    // BUDG-050 / BUDG-051 / BUDG-052: the create validator bounds Year to 2000–2100 and
    // Month to 1–12, so a navigator that has no clamp still can't create an out-of-range month.
    [Theory]
    [InlineData(1999, 7, false)]  // BUDG-050 year below range
    [InlineData(2000, 7, true)]   // lower bound inclusive
    [InlineData(2100, 7, true)]   // upper bound inclusive
    [InlineData(2101, 7, false)]  // BUDG-051 year above range
    [InlineData(2026, 0, false)]  // month below range
    [InlineData(2026, 13, false)] // BUDG-052 month above range (API-only)
    [InlineData(2026, 1, true)]
    [InlineData(2026, 12, true)]
    public void Validator_BoundsYearAndMonth(int year, int month, bool expectedValid)
    {
        new CreateBudgetMonthCommandValidator()
            .Validate(new CreateBudgetMonthCommand(year, month, CopyFromPrevious: false))
            .IsValid.Should().Be(expectedValid);
    }

    // BUDG-047: CreateBudgetMonthCommand is a plain command (not [AllowLimited]), so the
    // MediatR role gate blocks Limited and ReadOnly from creating a month.
    [Theory]
    [InlineData(HouseholdRole.Limited)]
    [InlineData(HouseholdRole.ReadOnly)]
    public async Task Create_IsBlocked_ForLimitedAndReadOnly(HouseholdRole role)
    {
        var behaviour =
            new AuthorizationBehaviour<CreateBudgetMonthCommand, BudgetMonthDto>(new RoleUserStub(role));
        RequestHandlerDelegate<BudgetMonthDto> next = _ => Task.FromResult(new BudgetMonthDto());

        var act = () => behaviour.Handle(
            new CreateBudgetMonthCommand(2026, 9, CopyFromPrevious: false), next, CancellationToken.None);

        await act.Should().ThrowAsync<ForbiddenAccessException>();
    }

    // BUDG-047 (positive side): Admin and Owner may create a month.
    [Theory]
    [InlineData(HouseholdRole.Admin)]
    [InlineData(HouseholdRole.Owner)]
    public async Task Create_IsAllowed_ForAdminAndOwner(HouseholdRole role)
    {
        var behaviour =
            new AuthorizationBehaviour<CreateBudgetMonthCommand, BudgetMonthDto>(new RoleUserStub(role));
        var ran = false;
        RequestHandlerDelegate<BudgetMonthDto> next = _ => { ran = true; return Task.FromResult(new BudgetMonthDto()); };

        await behaviour.Handle(
            new CreateBudgetMonthCommand(2026, 9, CopyFromPrevious: false), next, CancellationToken.None);

        ran.Should().BeTrue();
    }
}
