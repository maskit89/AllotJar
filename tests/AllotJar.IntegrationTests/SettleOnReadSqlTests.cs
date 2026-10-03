using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// D11 side effect on the reads that settle jar cycles (GetJars, the schedule and skip previews):
/// with row versions on jars and budget lines, a settle that loses to a concurrent write fails its
/// UPDATE where it used to overwrite. On a page load that is not the reader's failure: the read
/// treats the cycle as settled by the other write and answers from the database (#303 review P3-2
/// for the two-settles collision too). Each race is staged by committing the other write from a
/// second context just before the settle's own save.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class SettleOnReadSqlTests(SqlServerFixture fixture)
{
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly Deadline = Today.AddDays(-10);

    /// <summary>A Recurring jar whose cycle ended ten days ago with its target held: the next read settles it.</summary>
    private async Task<(string Owner, Guid JarId)> SeedFundedCycleAsync()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        await using var db = fixture.CreateContext();
        var account = new Account
        {
            OwnerId = owner, Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur,
            OpeningBalance = 5000m, OpeningDate = Deadline.AddMonths(-6),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync(Ct);
        var jar = new Jar
        {
            OwnerId = owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m, TargetDate = Deadline,
            CycleDeadline = Deadline, Accrual = AccrualMethod.TargetByDate, RecurMonths = 12, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync(Ct);
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = owner, AccountId = account.Id, Kind = JarAllocationKind.Reallocation, Date = Deadline.AddMonths(-5),
            CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = 600m }, new() { JarId = null, Amount = -600m } },
        });
        await db.SaveChangesAsync(Ct);
        return (owner, jar.Id);
    }

    /// <summary>A context whose first save first runs <paramref name="meanwhile"/> to completion in another context.</summary>
    private ApplicationDbContext RacedContext(Func<ApplicationDbContext, Task> meanwhile)
    {
        var options = new DbContextOptionsBuilder<ApplicationDbContext>(fixture.Options)
            .AddInterceptors(new BeforeFirstSave(async () =>
            {
                await using var other = fixture.CreateContext();
                await meanwhile(other);
            }))
            .Options;
        return new ApplicationDbContext(options);
    }

    private sealed class BeforeFirstSave(Func<Task> run) : SaveChangesInterceptor
    {
        private bool _ran;

        public override async ValueTask<InterceptionResult<int>> SavingChangesAsync(
            DbContextEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (!_ran)
            {
                _ran = true;
                await run();
            }
            return result;
        }
    }

    [Fact]
    public async Task Two_page_loads_settling_the_same_cycle_both_answer_and_record_it_once()
    {
        var (owner, jarId) = await SeedFundedCycleAsync();

        await using var db = RacedContext(other => JarCycles.SettleAsync(other, owner, Today, Ct));
        var jars = await new GetJarsQueryHandler(db, new CurrentUserStub(owner)).Handle(new GetJarsQuery(), Ct);

        jars.Should().ContainSingle(j => j.Id == jarId);
        await using var check = fixture.CreateContext();
        (await check.JarCycles.CountAsync(c => c.JarId == jarId, Ct)).Should().Be(1);
        (await check.Jars.SingleAsync(j => j.Id == jarId, Ct)).CycleDeadline.Should().Be(Deadline.AddMonths(12));
    }

    [Fact]
    public async Task A_page_load_whose_settle_meets_an_edit_of_the_jar_answers_and_the_next_read_settles()
    {
        var (owner, jarId) = await SeedFundedCycleAsync();
        Func<ApplicationDbContext, Task> rename = async other =>
        {
            var jar = await other.Jars.SingleAsync(j => j.Id == jarId, Ct);
            jar.Name = $"Insurance {Guid.NewGuid():N}"[..20];
            await other.SaveChangesAsync(Ct);
        };

        // Control: the settle on its own now fails on the jar's row version.
        await using (var control = RacedContext(rename))
        {
            var settle = () => JarCycles.SettleAsync(control, owner, Today, Ct);
            await settle.Should().ThrowAsync<DbUpdateConcurrencyException>();
        }

        await using (var db = RacedContext(rename))
        {
            var jars = await new GetJarsQueryHandler(db, new CurrentUserStub(owner)).Handle(new GetJarsQuery(), Ct);
            var jar = jars.Should().ContainSingle(j => j.Id == jarId).Which;
            jar.Name.Should().StartWith("Insurance ", "the read answers from the database as the edit left it");
        }
        await using (var check = fixture.CreateContext())
        {
            (await check.JarCycles.AnyAsync(c => c.JarId == jarId, Ct)).Should().BeFalse("the lost settle saved nothing");
        }

        await using (var next = fixture.CreateContext())
        {
            await new GetJarsQueryHandler(next, new CurrentUserStub(owner)).Handle(new GetJarsQuery(), Ct);
        }
        await using (var check = fixture.CreateContext())
        {
            (await check.JarCycles.CountAsync(c => c.JarId == jarId, Ct)).Should().Be(1);
            (await check.Jars.SingleAsync(j => j.Id == jarId, Ct)).CycleDeadline.Should().Be(Deadline.AddMonths(12));
        }
    }
}
