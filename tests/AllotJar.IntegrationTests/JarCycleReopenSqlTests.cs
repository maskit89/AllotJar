using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// MG-P2-2 (fix plan E, his 1 Oct answer "Reopen it") on the real schema: deleting the payment
/// that marked a Recurring cycle paid reopens the cycle, or, for an older cycle, keeps its row
/// with no payment — never a "Paid" row left pointing at nothing by the SET NULL foreign key.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class JarCycleReopenSqlTests
{
    private readonly SqlServerFixture _fixture;

    public JarCycleReopenSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);

    private async Task<(string Owner, Guid JarId, Guid PaymentId)> SeedAsync(DateOnly due, int recurMonths, decimal held, decimal paid, DateOnly paidOn)
    {
        var owner = $"user-{Guid.NewGuid():N}";
        await using var db = _fixture.CreateContext();
        var account = new Account
        {
            OwnerId = owner, Name = "Savings", Type = AccountType.Savings, Currency = CurrencyCode.Eur,
            OpeningBalance = 5000m, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        var jar = new Jar
        {
            OwnerId = owner, Name = "Insurance", Kind = JarKind.Recurring, TargetAmount = 600m, TargetDate = due,
            CycleDeadline = due, Accrual = AccrualMethod.TargetByDate, RecurMonths = recurMonths, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = owner, AccountId = account.Id, Kind = JarAllocationKind.Reallocation, Date = new DateOnly(2026, 1, 2),
            CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = jar.Id, Amount = held }, new() { JarId = null, Amount = -held } },
        });
        var payment = new Transaction
        {
            OwnerId = owner, AccountId = account.Id, Amount = paid, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
            Date = paidOn, Payee = "Insurer",
        };
        db.Transactions.Add(payment);
        await db.SaveChangesAsync();
        return (owner, jar.Id, payment.Id);
    }

    [Fact]
    public async Task Deleting_the_payment_of_the_latest_cycle_reopens_it()
    {
        var due = Today.AddMonths(3);
        var (owner, jarId, paymentId) = await SeedAsync(due, 12, 450m, 400m, Today);
        await using (var db = _fixture.CreateContext())
        {
            await new MarkJarCyclePaidCommandHandler(db, new CurrentUserStub(owner)).Handle(new MarkJarCyclePaidCommand(jarId, due, paymentId), CancellationToken.None);
        }
        await using (var db = _fixture.CreateContext())
        {
            await new DeleteTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(new DeleteTransactionCommand(paymentId), CancellationToken.None);
        }
        await using (var db = _fixture.CreateContext())
        {
            (await db.JarCycles.AnyAsync(c => c.JarId == jarId)).Should().BeFalse();
            (await db.Jars.SingleAsync(j => j.Id == jarId)).CycleDeadline.Should().Be(due);
        }
    }

    [Fact]
    public async Task Deleting_the_payment_of_an_older_cycle_keeps_it_closed_without_a_payment()
    {
        var firstDue = Today.AddDays(-60);
        var (owner, jarId, paymentId) = await SeedAsync(firstDue, 1, 600m, 550m, firstDue.AddDays(-2));
        await using (var db = _fixture.CreateContext())
        {
            await new MarkJarCyclePaidCommandHandler(db, new CurrentUserStub(owner)).Handle(new MarkJarCyclePaidCommand(jarId, firstDue, paymentId), CancellationToken.None);
        }
        await using (var db = _fixture.CreateContext())
        {
            await new DeleteTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(new DeleteTransactionCommand(paymentId), CancellationToken.None);
        }
        await using (var db = _fixture.CreateContext())
        {
            var first = await db.JarCycles.SingleAsync(c => c.JarId == jarId && c.Deadline == firstDue);
            first.Outcome.Should().Be(JarCycleOutcome.Funded);
            first.PaymentTransactionId.Should().BeNull();
            first.PaidOn.Should().BeNull();
            first.PaidAmount.Should().BeNull();
            (await db.Transactions.AnyAsync(t => t.Id == paymentId)).Should().BeFalse();
        }
    }
}
