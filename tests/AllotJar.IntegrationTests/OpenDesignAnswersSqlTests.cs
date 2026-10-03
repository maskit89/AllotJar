using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.CompleteJar;
using AllotJar.Application.Jars.Commands.ReopenJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.IntegrationTests;

/// <summary>
/// The open design answers of 1 October 2026 on the real schema: the hand-typed mark (O3b, the
/// additive IsPlannedByHand column) survives a retarget's replant, a completed Goal reopens (O3c),
/// and a refund nets its purchase's jar line from another account (O9a) or, against a completed
/// Goal, goes back into the jar (O9b).
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class OpenDesignAnswersSqlTests
{
    private readonly SqlServerFixture _fixture;

    public OpenDesignAnswersSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly Current = new(Today.Year, Today.Month, 1);

    private sealed record Seeded(string Owner, Guid Savings, Guid Everyday, Guid JarId, Guid[] Lines);

    /// <summary>A 300 Goal in Savings due in three months, planned 100 in each of three months, holding 200.</summary>
    private async Task<Seeded> SeedAsync()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        await using var db = _fixture.CreateContext();
        var savings = new Account
        {
            OwnerId = owner, Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur,
            OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1),
        };
        var everyday = new Account
        {
            OwnerId = owner, Name = "Everyday", Type = AccountType.Current, Currency = CurrencyCode.Eur,
            OpeningBalance = 100m, OpeningDate = new DateOnly(2026, 1, 1), DisplayOrder = 1,
        };
        db.Accounts.AddRange(savings, everyday);
        await db.SaveChangesAsync();
        var jar = new Jar
        {
            OwnerId = owner, Name = "Sofa", Kind = JarKind.Goal, TargetAmount = 300m, TargetDate = Current.AddMonths(3),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = savings.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        var lines = new List<Guid>();
        for (var i = 0; i < 3; i++)
        {
            var month = Current.AddMonths(i);
            var line = new BudgetItem { Name = "Sofa", PlannedAmount = 100m, SavingsId = jar.Id };
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory>
                {
                    new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } },
                },
            });
            await db.SaveChangesAsync();
            lines.Add(line.Id);
        }
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = owner, AccountId = savings.Id, Kind = JarAllocationKind.InitialAllocation, Date = new DateOnly(2026, 1, 2),
            CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = 200m }, new() { JarId = null, Amount = -200m } },
        });
        await db.SaveChangesAsync();
        return new Seeded(owner, savings.Id, everyday.Id, jar.Id, lines.ToArray());
    }

    [Fact]
    public async Task A_hand_typed_later_line_keeps_its_amount_through_a_retarget()
    {
        var s = await SeedAsync();
        var user = new CurrentUserStub(s.Owner);
        await using (var db = _fixture.CreateContext())
        {
            await new UpdateBudgetItemCommandHandler(db, user).Handle(new UpdateBudgetItemCommand(s.Lines[2], 150m), Ct);
        }
        await using (var db = _fixture.CreateContext())
        {
            // 200 held, 600 wanted: the month after next keeps 150, the other two share 250.
            var preview = await new GetJarScheduleQueryHandler(db, user).Handle(
                new GetJarScheduleQuery(s.JarId, JarKind.Goal, 600m, Current.AddMonths(3), AccrualMethod.TargetByDate), Ct);
            preview.Months.Select(m => (m.Planned, m.ByHand)).Should().Equal((125m, false), (125m, false), (150m, true));
            await new UpdateJarCommandHandler(db, user).Handle(new UpdateJarCommand(
                s.JarId, "Sofa", JarKind.Goal, 600m, Current.AddMonths(3), AccrualMethod.TargetByDate, s.Savings), Ct);
        }
        await using (var db = _fixture.CreateContext())
        {
            var planned = await db.BudgetItems.Where(i => s.Lines.Contains(i.Id))
                .ToDictionaryAsync(i => i.Id, i => (i.PlannedAmount, i.IsPlannedByHand));
            planned[s.Lines[0]].Should().Be((125m, false));
            planned[s.Lines[1]].Should().Be((125m, false));
            planned[s.Lines[2]].Should().Be((150m, true));
        }
    }

    [Fact]
    public async Task Refunds_net_the_jar_line_from_another_account_and_refill_a_completed_goal_from_its_own()
    {
        var s = await SeedAsync();
        var user = new CurrentUserStub(s.Owner);
        Guid purchaseId;
        await using (var db = _fixture.CreateContext())
        {
            var purchase = await new CreateTransactionCommandHandler(db, user).Handle(
                new CreateTransactionCommand(Today, "Sofa shop", 150m, TransactionType.Expense, s.Lines[0], AccountId: s.Savings), Ct);
            purchaseId = purchase.Id;
            await new CompleteJarCommandHandler(db, user).Handle(new CompleteJarCommand(s.JarId), Ct);
        }
        await using (var db = _fixture.CreateContext())
        {
            // O9a: 20 back to Everyday sits on Sofa's line; Sofa still holds its 50.
            var away = await new CreateTransactionCommandHandler(db, user).Handle(
                new CreateTransactionCommand(Today, "Sofa shop refund", 20m, TransactionType.Income, null, AccountId: s.Everyday,
                    RefundOfTransactionId: purchaseId), Ct);
            away.BudgetItemId.Should().Be(s.Lines[0]);
            // O9b: 30 back to Savings goes back into the completed Goal.
            await new CreateTransactionCommandHandler(db, user).Handle(
                new CreateTransactionCommand(Today, "Sofa shop refund", 30m, TransactionType.Income, null, AccountId: s.Savings,
                    RefundOfTransactionId: purchaseId), Ct);
        }
        await using (var db = _fixture.CreateContext())
        {
            (await JarLedgerReader.ReadAsync(db, s.Owner, Today, Ct)).BalanceOf(s.JarId).Should().Be(80m);
            var reopened = await new ReopenJarCommandHandler(db, user).Handle(new ReopenJarCommand(s.JarId), Ct);
            reopened.CompletedOn.Should().BeNull();
            reopened.CurrentBalance.Should().Be(80m);
        }
    }
}
