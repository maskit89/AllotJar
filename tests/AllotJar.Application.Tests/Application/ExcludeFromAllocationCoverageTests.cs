using FluentAssertions;
using Xunit;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Residual-gap coverage for <see cref="BudgetCategory.ExcludeFromAllocation"/>
/// (docs/testing/cases: TX-095 in 10-transactions.md, ALLOC-036 in 14-allocation.md).
/// The flag has NO UI control and NO API writer — only the data migration and the Excel
/// importer ever set it — so it cannot be journey-tested; here it is seeded directly on the
/// entity and asserted through the REAL read paths on both sides of the contract:
/// <list type="bullet">
///   <item>TX-095 — GetBudgetMonth (BudgetActuals): transactions assigned to a line inside an
///   excluded category still derive that line's actual identically to any other line; the
///   flag never suppresses transaction-derived actuals (whole or split-slice).</item>
///   <item>ALLOC-036 — PreviewIncomeAllocation (AllocationPlanner): excluded categories of
///   BOTH kinds (Expense and Savings) are dropped from the pooled envelopes/jars obligation
///   totals while comparable non-excluded categories stay in, so the allocation output is
///   never double-counted as a cost.</item>
/// </list>
/// </summary>
public class ExcludeFromAllocationCoverageTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private const string Owner = "user-1";

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>()
            .UseInMemoryDatabase($"zbb-excl-alloc-{Guid.NewGuid()}")
            .Options);

    // TX-095 — an expense assigned to a line inside an ExcludeFromAllocation category counts
    // toward that line's transaction-derived actual EXACTLY like a line in a normal category:
    // both the whole-transaction path and the split-slice path land, and the excluded line's
    // derived actual equals the control line's to the cent. The flag has no actuals-side effect.
    [Fact]
    public async Task Tx095_ExcludedCategoryLine_DerivesActualsIdenticallyToAControlLine()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);

        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var surplus = new BudgetItem { Name = "Surplus", PlannedAmount = 400m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new()
                {
                    Name = "Everyday", Kind = CategoryKind.Expense, DisplayOrder = 0,
                    Items = new List<BudgetItem> { groceries }, // control line
                },
                new()
                {
                    Name = "Personal Savings", Kind = CategoryKind.Expense, DisplayOrder = 1,
                    ExcludeFromAllocation = true, // the flag under test
                    Items = new List<BudgetItem> { surplus },
                },
            },
        });
        await db.SaveChangesAsync();

        // Identical whole expenses assigned to each line.
        foreach (var itemId in new[] { groceries.Id, surplus.Id })
        {
            db.Transactions.Add(new Transaction
            {
                OwnerId = Owner, Date = new DateOnly(2026, 7, 10), Payee = "Whole",
                Amount = 50m, Type = TransactionType.Expense, BudgetItemId = itemId,
            });
        }

        // One split parent slicing identically into both lines (parent stays unassigned).
        var parent = new Transaction
        {
            OwnerId = Owner, Date = new DateOnly(2026, 7, 12), Payee = "Split",
            Amount = 50m, Type = TransactionType.Expense, BudgetItemId = null,
        };
        parent.Splits.Add(new TransactionSplit { BudgetItemId = groceries.Id, Amount = 25m });
        parent.Splits.Add(new TransactionSplit { BudgetItemId = surplus.Id, Amount = 25m });
        db.Transactions.Add(parent);
        await db.SaveChangesAsync();

        var month = await new GetBudgetMonthQueryHandler(db, user)
            .Handle(new GetBudgetMonthQuery(2026, 7), CancellationToken.None);
        var items = month.Categories.SelectMany(c => c.Items).ToList();

        // Whole 50 + split slice 25 on each line; the excluded line matches the control exactly.
        items.Single(i => i.Id == surplus.Id).ActualAmount.Should().Be(75m);
        items.Single(i => i.Id == groceries.Id).ActualAmount.Should().Be(75m);
    }

    // ALLOC-036 — the allocation preview (the real handler → AllocationPlanner) leaves excluded
    // categories of BOTH kinds out of the pooled obligation totals: an excluded Expense category
    // is dropped from "Cover shared costs" and an excluded Savings category from "Fund the jars",
    // while comparable non-excluded categories of the same kinds stay in. Were the flag ignored,
    // envelopes would read 2,800 and jars 1,300.
    [Fact]
    public async Task Alloc036_ExcludedExpenseAndSavingsCategories_AreLeftOutOfThePooledTotals()
    {
        await using var db = NewContext();
        var user = new CurrentUserStub(Owner);
        var alex = new HouseholdMember { OwnerId = Owner, Name = "Alex", NetMonthlyIncome = 3000m, DisplayOrder = 0 };
        var robin = new HouseholdMember { OwnerId = Owner, Name = "Robin", NetMonthlyIncome = 2000m, DisplayOrder = 1 };
        db.HouseholdMembers.AddRange(alex, robin);

        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = 2026, Month = 7, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                // The month's income — the pool (rule 28): 3,000 + 2,000 attributed to the two members.
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem>
                {
                    new() { Name = "Alex", PlannedAmount = 3000m, MemberId = alex.Id },
                    new() { Name = "Robin", PlannedAmount = 2000m, MemberId = robin.Id },
                } },
                // Comparable INCLUDED categories — the catalog's worked example (2,000 / 500).
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { new() { Name = "Living", PlannedAmount = 2000m } } },
                new() { Name = "Funds", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = "Funds", SavingsId = Guid.NewGuid(), PlannedAmount = 500m } } },
                // EXCLUDED categories, one per kind — allocation outputs, not costs.
                new() { Name = "Personal Savings", Kind = CategoryKind.Expense, ExcludeFromAllocation = true, Items = new List<BudgetItem> { new() { Name = "Surplus", PlannedAmount = 800m } } },
                new() { Name = "Excluded Jar", Kind = CategoryKind.Savings, ExcludeFromAllocation = true, Items = new List<BudgetItem> { new() { Name = "Hidden", SavingsId = Guid.NewGuid(), PlannedAmount = 800m } } },
            },
        });
        await db.SaveChangesAsync();

        await new UpsertAllocationProfileCommandHandler(db, user).Handle(
            new UpsertAllocationProfileCommand(null, "Household allocation", null, new List<AllocationRuleSpec>
            {
                new(0, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m),
                new(1, AllocationRuleType.FundJars, SplitMethod.Equal, 0m),
                new(2, AllocationRuleType.FixedPerMember, SplitMethod.Equal, 0m),
                new(3, AllocationRuleType.SplitRemainderToMembers, SplitMethod.Equal, 0m),
            }),
            CancellationToken.None);

        var result = await new PreviewIncomeAllocationQueryHandler(db, user)
            .Handle(new PreviewIncomeAllocationQuery(2026, 7), CancellationToken.None);

        // Both flagged 800s are dropped; only the comparable non-excluded categories count.
        result.EnvelopesTotal.Should().Be(2000m);
        result.JarsTotal.Should().Be(500m);
        result.Steps.Single(s => s.Type == AllocationRuleType.FundEnvelopes).Total.Should().Be(2000m);
        result.Steps.Single(s => s.Type == AllocationRuleType.FundJars).Total.Should().Be(500m);

        // And the surplus is therefore NOT double-deducted: pool 5,000 − 2,500 = 2,500 to savings.
        result.Pool.Should().Be(5000m);
        result.Steps.Single(s => s.Type == AllocationRuleType.SplitRemainderToMembers).Total.Should().Be(2500m);
    }
}
