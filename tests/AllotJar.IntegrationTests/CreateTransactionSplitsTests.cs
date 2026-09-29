using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// CreateTransaction with Splits is a new writer of <c>TransactionSplits</c> rows — three
/// enforced foreign keys (TransactionId, BudgetItemId, MemberId) the EF in-memory suite
/// cannot validate. These run the real handler against SQL Server: the parent + slices must
/// insert atomically in one SaveChanges, and a failed validation must leave no torn parent.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class CreateTransactionSplitsTests
{
    private readonly SqlServerFixture _fixture;

    public CreateTransactionSplitsTests(SqlServerFixture fixture) => _fixture = fixture;

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private sealed record Seeded(BudgetItem Groceries, BudgetItem Household, HouseholdMember Alex);

    private static async Task<Seeded> SeedAsync(ApplicationDbContext db, string ownerId)
    {
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 400m };
        var household = new BudgetItem { Name = "Household", PlannedAmount = 100m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = ownerId,
            Year = 2026,
            Month = 6,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Food", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { groceries, household } },
            },
        });
        var alex = new HouseholdMember { OwnerId = ownerId, Name = "Alex" };
        db.HouseholdMembers.Add(alex);
        await db.SaveChangesAsync();
        return new Seeded(groceries, household, alex);
    }

    [Fact]
    public async Task CreateWithSplits_InsertsParentAndSlicesAtomically_AgainstEnforcedFks()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var s = await SeedAsync(db, owner);

        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub(owner));
        var dto = await handler.Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 6, 5), "Supermarket", 100m, TransactionType.Expense,
                BudgetItemId: null,
                Splits: new List<SplitAllocationInput>
                {
                    new(s.Groceries.Id, 70m, s.Alex.Id),
                    new(s.Household.Id, 30m),
                }),
            CancellationToken.None);

        dto.IsSplit.Should().BeTrue();
        dto.BudgetItemId.Should().BeNull();
        dto.Splits.Select(x => x.BudgetItemName).Should().BeEquivalentTo(new[] { "Groceries", "Household" });
        dto.Splits.Single(x => x.MemberName == "Alex").Amount.Should().Be(70m);

        await using var verify = _fixture.CreateContext();
        var saved = await verify.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .SingleAsync(t => t.OwnerId == owner);
        saved.BudgetItemId.Should().BeNull();
        saved.Splits.Should().HaveCount(2);
        saved.Splits.Sum(x => x.Amount).Should().Be(100m);
    }

    [Fact]
    public async Task CreateWithSplits_FailedValidation_LeavesNoTornParentRow()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var s = await SeedAsync(db, owner);

        var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub(owner));
        var act = () => handler.Handle(
            new CreateTransactionCommand(
                new DateOnly(2026, 6, 5), "Supermarket", 100m, TransactionType.Expense,
                BudgetItemId: null,
                Splits: new List<SplitAllocationInput>
                {
                    new(s.Groceries.Id, 70m),
                    new(s.Household.Id, 20m), // does not sum to 100
                }),
            CancellationToken.None);

        await act.Should().ThrowAsync<ValidationException>();

        await using var verify = _fixture.CreateContext();
        // No parent row means no orphaned slices either — the FK guarantees it.
        (await verify.Transactions.AsNoTracking().CountAsync(t => t.OwnerId == owner)).Should().Be(0);
    }
}
