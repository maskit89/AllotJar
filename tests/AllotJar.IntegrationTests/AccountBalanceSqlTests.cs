using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Rule 74 under real concurrency: the per-account ledger lock
/// (<see cref="IApplicationDbContext.BeginLedgerWriteAsync"/>) serialises two payments from the
/// same account so the second validates against the committed balance and the account can never
/// be taken below zero by a race that EF InMemory cannot reproduce.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class AccountBalanceSqlTests
{
    private readonly SqlServerFixture _fixture;

    public AccountBalanceSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static async Task<Account> SeedAccountAsync(ApplicationDbContext db, string owner, string name, decimal opening)
    {
        var account = new Account
        {
            OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
    }

    [Fact]
    public async Task Concurrent_payments_are_serialised_so_the_account_never_goes_below_zero()
    {
        // Current holds 100. Two payments of 80 are recorded at the same moment on separate
        // connections: exactly one is accepted, the other is refused with the rule 74 message,
        // and the account ends at 20 — never −60.
        var owner = NewOwner();
        Account account;
        await using (var seed = _fixture.CreateContext())
        {
            account = await SeedAccountAsync(seed, owner, "Current", 100m);
        }

        async Task<Exception?> TryPay()
        {
            await using var db = _fixture.CreateContext();
            var handler = new CreateTransactionCommandHandler(db, new CurrentUserStub(owner));
            try
            {
                await handler.Handle(
                    new CreateTransactionCommand(new DateOnly(2026, 6, 10), "Shop", 80m, TransactionType.Expense, null, account.Id),
                    CancellationToken.None);
                return null;
            }
            catch (Exception ex)
            {
                return ex;
            }
        }

        var results = await Task.WhenAll(TryPay(), TryPay());

        var failures = results.Where(r => r is not null).ToList();
        failures.Should().ContainSingle("exactly one of the two racing payments must be refused");
        failures[0].Should().BeOfType<ValidationException>();
        ((ValidationException)failures[0]!).Errors["Amount"].Single().Should().Contain("Current would be -60.00 EUR on 2026-06-10");

        await using var verify = _fixture.CreateContext();
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner)).Should().Be(1);
    }

    [Fact]
    public async Task Concurrent_transfer_and_payment_from_one_account_leave_it_at_or_above_zero()
    {
        var owner = NewOwner();
        Account source;
        Account savings;
        await using (var seed = _fixture.CreateContext())
        {
            source = await SeedAccountAsync(seed, owner, "Current", 100m);
            savings = await SeedAccountAsync(seed, owner, "Savings", 0m);
        }

        async Task<Exception?> TryTransfer()
        {
            await using var db = _fixture.CreateContext();
            try
            {
                await new CreateTransferCommandHandler(db, new CurrentUserStub(owner)).Handle(
                    new CreateTransferCommand(new DateOnly(2026, 6, 10), 70m, source.Id, savings.Id), CancellationToken.None);
                return null;
            }
            catch (Exception ex)
            {
                return ex;
            }
        }

        async Task<Exception?> TryPay()
        {
            await using var db = _fixture.CreateContext();
            try
            {
                await new CreateTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(
                    new CreateTransactionCommand(new DateOnly(2026, 6, 11), "Shop", 70m, TransactionType.Expense, null, source.Id),
                    CancellationToken.None);
                return null;
            }
            catch (Exception ex)
            {
                return ex;
            }
        }

        var results = await Task.WhenAll(TryTransfer(), TryPay());

        results.Count(r => r is null).Should().Be(1, "only one of the two 70s fits in 100");
        results.Where(r => r is not null).Should().AllBeOfType<ValidationException>();

        await using var verify = _fixture.CreateContext();
        var rows = await verify.Transactions.Where(t => t.OwnerId == owner).ToListAsync();
        rows.Should().HaveCount(1);
    }
}
