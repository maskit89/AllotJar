using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Api.Middleware;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Follow-ups F2 against SQL Server (1 October 2026): two requests closing the same jar cycle at
/// once (SC-P3-4). The unique cycle index keeps one; the other's failure is recognised, so the API
/// answers "reload and try again" instead of a 500.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class FollowUpsF2SqlTests
{
    private readonly SqlServerFixture _fixture;

    public FollowUpsF2SqlTests(SqlServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task A_second_close_of_the_same_cycle_is_recognised_as_a_collision()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var deadline = new DateOnly(2026, 9, 1);
        Guid jarId;
        await using (var db = _fixture.CreateContext())
        {
            var account = new Account { OwnerId = owner, Name = "Bills", Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1) };
            db.Accounts.Add(account);
            var jar = new Jar
            {
                OwnerId = owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m, Accrual = AccrualMethod.TargetByDate,
                TargetDate = deadline, RecurMonths = 12, CycleDeadline = deadline, FundingAccount = account,
            };
            db.Jars.Add(jar);
            await db.SaveChangesAsync();
            jarId = jar.Id;
        }

        JarCycle Closed() => new()
        {
            OwnerId = owner, JarId = jarId, Deadline = deadline, TargetAmount = 600m, Outcome = JarCycleOutcome.Funded,
            BalanceAtDeadline = 600m, ClosedOn = deadline, CreatedUtc = DateTime.UtcNow,
        };
        await using (var first = _fixture.CreateContext())
        {
            first.JarCycles.Add(Closed());
            await first.SaveChangesAsync();
        }

        await using var second = _fixture.CreateContext();
        second.JarCycles.Add(Closed());
        var save = () => second.SaveChangesAsync();

        var failure = (await save.Should().ThrowAsync<DbUpdateException>()).Which;
        ExceptionHandlingMiddleware.IsJarCycleCollision(failure).Should().BeTrue();
    }
}
