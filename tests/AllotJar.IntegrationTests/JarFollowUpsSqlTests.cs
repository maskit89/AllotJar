using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Household;
using AllotJar.Application.Household.Commands.ArchiveHouseholdMember;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Follow-ups D13 and D16 on the real schema: the queries that find a pocket-money payment still
/// waiting for its converted amount, and whether a jar has left an account since a transfer,
/// translate and answer as the in-memory tests expect.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class JarFollowUpsSqlTests
{
    private readonly SqlServerFixture _fixture;

    public JarFollowUpsSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static readonly DateOnly Jan1 = new(2026, 1, 1);
    private static readonly DateOnly Jan2 = new(2026, 1, 2);

    [Fact]
    public async Task D13_Cancelling_keeps_the_plan_of_a_line_whose_payment_waits_for_its_converted_amount()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        Guid kidId, lineId;
        await using (var db = _fixture.CreateContext())
        {
            var kid = new HouseholdMember { OwnerId = owner, Name = "Kid" };
            db.HouseholdMembers.Add(kid);
            await db.SaveChangesAsync();
            var line = new BudgetItem { Name = "Kid", PlannedAmount = 50m, MemberId = kid.Id };
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = owner, Year = today.Year, Month = today.Month, BaseCurrency = CurrencyCode.Eur,
                Categories = { new BudgetCategory { Name = "Pocket Money", Kind = CategoryKind.Expense, ExcludeFromAllocation = true, Items = { line } } },
            });
            await db.SaveChangesAsync();
            db.Transactions.Add(new Transaction
            {
                OwnerId = owner, Date = new DateOnly(today.Year, today.Month, 1), Payee = "Pocket money", Amount = 25m,
                Type = TransactionType.Expense, BudgetItemId = line.Id, Currency = CurrencyCode.From("GBP"), FxPending = true,
            });
            await db.SaveChangesAsync();
            (kidId, lineId) = (kid.Id, line.Id);
        }

        await using (var db = _fixture.CreateContext())
        {
            await new ArchiveHouseholdMemberCommandHandler(db, new CurrentUserStub(owner))
                .Handle(new ArchiveHouseholdMemberCommand(kidId, true, PocketMoneyDecision.Cancel), CancellationToken.None);
        }

        await using (var db = _fixture.CreateContext())
        {
            (await db.BudgetItems.SingleAsync(i => i.Id == lineId)).PlannedAmount.Should().Be(50m);
        }
    }

    [Fact]
    public async Task D16_Removing_a_return_the_jar_spent_since_is_refused()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var user = new CurrentUserStub(owner);
        Account a, b;
        Jar holiday, car;
        await using (var db = _fixture.CreateContext())
        {
            a = new Account { OwnerId = owner, Name = "A", Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = Jan1 };
            b = new Account { OwnerId = owner, Name = "B", Type = AccountType.Savings, Currency = CurrencyCode.Eur, OpeningBalance = 0m, OpeningDate = Jan1, DisplayOrder = 1 };
            db.Accounts.AddRange(a, b);
            await db.SaveChangesAsync();
            holiday = Goal(owner, a, "Holiday");
            car = Goal(owner, a, "Car");
            db.Jars.AddRange(holiday, car);
            await db.SaveChangesAsync();
            db.JarAllocations.Add(new JarAllocation
            {
                OwnerId = owner, AccountId = a.Id, Kind = JarAllocationKind.Reallocation, Date = Jan1, CreatedUtc = DateTime.UtcNow,
                Postings = new List<JarAllocationPosting> { new() { JarId = holiday.Id, Amount = 100m }, new() { JarId = null, Amount = -100m } },
            });
            await db.SaveChangesAsync();
        }

        Guid transferId;
        await using (var db = _fixture.CreateContext())
        {
            transferId = (await new CreateTransferCommandHandler(db, user).Handle(
                new CreateTransferCommand(Jan2, 100m, a.Id, b.Id, FromJarId: holiday.Id), CancellationToken.None)).Id;
        }
        await using (var db = _fixture.CreateContext())
        {
            await new UpdateTransferCommandHandler(db, user).Handle(
                new UpdateTransferCommand(transferId, a.Id, b.Id, 100m, Jan2, null, new DateOnly(2026, 1, 5), FromJarId: holiday.Id), CancellationToken.None);
        }
        await using (var db = _fixture.CreateContext())
        {
            await new ReallocateJarMoneyCommandHandler(db, user).Handle(
                new ReallocateJarMoneyCommand(a.Id, holiday.Id, car.Id, 100m, new DateOnly(2026, 1, 15)), CancellationToken.None);
        }

        await using (var db = _fixture.CreateContext())
        {
            var act = () => new UpdateTransferCommandHandler(db, user).Handle(
                new UpdateTransferCommand(transferId, a.Id, b.Id, 100m, Jan2, Jan2, FromJarId: holiday.Id), CancellationToken.None);
            (await act.Should().ThrowAsync<ValidationException>()).Which.Errors.Should().ContainKey("FromJarId");
        }
        await using (var db = _fixture.CreateContext())
        {
            (await db.Transactions.SingleAsync(t => t.Id == transferId)).ReturnedOn.Should().Be(new DateOnly(2026, 1, 5));
        }
    }

    private static Jar Goal(string owner, Account account, string name) => new()
    {
        OwnerId = owner, Name = name, Kind = JarKind.Goal, TargetAmount = 1200m, TargetDate = new DateOnly(2027, 7, 1),
        Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
    };
}
