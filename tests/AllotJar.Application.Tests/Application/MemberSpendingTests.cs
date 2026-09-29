using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Xunit;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Queries.GetMemberSpending;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The per-member spending lens: attributed expense per active member, combining
/// whole-transaction attribution and the per-member slices of split transactions.
/// </summary>
public class MemberSpendingTests
{
    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    [Fact]
    public async Task Spending_SumsWholeTransactionsAndSlicesPerMember()
    {
        await using var db = NewContext();
        var alex = new HouseholdMember { OwnerId = "user-1", Name = "Alex", DisplayOrder = 0 };
        var sam = new HouseholdMember { OwnerId = "user-1", Name = "Sam", DisplayOrder = 1 };
        db.HouseholdMembers.AddRange(alex, sam);

        // A whole expense attributed to Alex.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "Shop",
            Amount = 50m, Type = TransactionType.Expense, MemberId = alex.Id,
        });
        // Income attributed to Alex must NOT count as spend.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 2), Payee = "Pay",
            Amount = 999m, Type = TransactionType.Income, MemberId = alex.Id,
        });
        // A split expense divided Alex 30 / Sam 70.
        var split = new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 3), Payee = "Dinner",
            Amount = 100m, Type = TransactionType.Expense,
        };
        db.Transactions.Add(split);
        await db.SaveChangesAsync();
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, MemberId = alex.Id, Amount = 30m });
        db.TransactionSplits.Add(new TransactionSplit { TransactionId = split.Id, MemberId = sam.Id, Amount = 70m });
        await db.SaveChangesAsync();

        var handler = new GetMemberSpendingQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetMemberSpendingQuery(), CancellationToken.None);

        result.Single(m => m.Name == "Alex").Spent.Should().Be(80m); // 50 whole + 30 slice
        result.Single(m => m.Name == "Sam").Spent.Should().Be(70m);  // slice only
    }

    [Fact]
    public async Task Spending_ExcludesArchivedMembers()
    {
        await using var db = NewContext();
        var active = new HouseholdMember { OwnerId = "user-1", Name = "Active" };
        var archived = new HouseholdMember { OwnerId = "user-1", Name = "Archived", IsArchived = true };
        db.HouseholdMembers.AddRange(active, archived);
        await db.SaveChangesAsync();
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", Date = new DateOnly(2026, 6, 1), Payee = "x",
            Amount = 10m, Type = TransactionType.Expense, MemberId = archived.Id,
        });
        await db.SaveChangesAsync();

        var handler = new GetMemberSpendingQueryHandler(db, new CurrentUserStub("user-1"));
        var result = await handler.Handle(new GetMemberSpendingQuery(), CancellationToken.None);

        result.Should().ContainSingle().Which.Name.Should().Be("Active");
        result.Single().Spent.Should().Be(0m);
    }
}
