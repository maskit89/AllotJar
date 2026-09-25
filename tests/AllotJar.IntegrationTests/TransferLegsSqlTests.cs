using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Relational guarantees for transfer bank legs that EF InMemory cannot see: the check
/// constraint refusing a transfer with no leg, the unique receipt-reference index on the
/// destination account, and the commit's recovery when a concurrent commit confirms the same
/// receipt reference first.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class TransferLegsSqlTests
{
    private readonly SqlServerFixture _fixture;

    public TransferLegsSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    /// <summary>Returns rate 1 and, on its FIRST call, runs a callback — the window between the
    /// handler's dedup snapshot and its save.</summary>
    private sealed class TrapRateProvider(Func<Task>? onFirstCall = null) : IExchangeRateProvider
    {
        private bool _fired;

        public async Task<decimal?> GetRateAsync(
            CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
        {
            if (!_fired && onFirstCall is not null)
            {
                _fired = true;
                await onFirstCall();
            }
            return 1m;
        }
    }

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static async Task<Account> SeedAccountAsync(ApplicationDbContext db, string owner, string name, string currency = "EUR")
    {
        var account = new Account
        {
            OwnerId = owner, Name = name, Currency = CurrencyCode.From(currency), OpeningDate = new DateOnly(2026, 1, 1),
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
    }

    private static Transaction Transfer(
        string owner, Guid from, Guid to, DateOnly? departedOn, DateOnly? receivedOn,
        string? receiptReference = null, string currency = "EUR") => new()
    {
        OwnerId = owner, Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.From(currency),
        Date = departedOn ?? receivedOn ?? new DateOnly(2026, 9, 30), DepartedOn = departedOn, ReceivedOn = receivedOn,
        AccountId = from, TransferAccountId = to, ReceiptBankReference = receiptReference, Payee = "TRANSFER",
    };

    [Fact]
    public async Task Database_refuses_a_transfer_with_no_bank_leg()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var a = await SeedAccountAsync(db, owner, "A");
        var b = await SeedAccountAsync(db, owner, "B");

        db.Transactions.Add(Transfer(owner, a.Id, b.Id, departedOn: null, receivedOn: null));
        var act = () => db.SaveChangesAsync();

        // CK_Transactions_TransferLegs: a transfer is never recorded with a date the ledger must guess.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Database_accepts_either_leg_alone_and_both_together()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var a = await SeedAccountAsync(db, owner, "A");
        var b = await SeedAccountAsync(db, owner, "B");

        db.Transactions.Add(Transfer(owner, a.Id, b.Id, new DateOnly(2026, 9, 30), null));
        db.Transactions.Add(Transfer(owner, a.Id, b.Id, null, new DateOnly(2026, 10, 1)));
        db.Transactions.Add(Transfer(owner, a.Id, b.Id, new DateOnly(2026, 9, 30), new DateOnly(2026, 10, 1)));

        var act = () => db.SaveChangesAsync();
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Database_refuses_a_duplicate_receipt_reference_on_the_same_destination_account()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var a = await SeedAccountAsync(db, owner, "A");
        var b = await SeedAccountAsync(db, owner, "B");
        db.Transactions.Add(Transfer(owner, a.Id, b.Id, null, new DateOnly(2026, 10, 1), receiptReference: "B-RCPT-1"));
        await db.SaveChangesAsync();

        await using var second = _fixture.CreateContext();
        second.Transactions.Add(Transfer(owner, a.Id, b.Id, null, new DateOnly(2026, 10, 1), receiptReference: "b-rcpt-1"));
        var act = () => second.SaveChangesAsync();

        // Same destination statement, same reference (case-insensitively): the movement is already known.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Same_receipt_reference_into_different_destination_accounts_is_allowed()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var a = await SeedAccountAsync(db, owner, "A");
        var b = await SeedAccountAsync(db, owner, "B");
        var c = await SeedAccountAsync(db, owner, "C");
        db.Transactions.Add(Transfer(owner, a.Id, b.Id, null, new DateOnly(2026, 10, 1), receiptReference: "shared"));
        db.Transactions.Add(Transfer(owner, a.Id, c.Id, null, new DateOnly(2026, 10, 1), receiptReference: "shared"));

        var act = () => db.SaveChangesAsync();
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Commit_recovers_when_a_concurrent_commit_confirms_the_same_receipt_reference_first()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        // USD accounts with no USD budget month: the plain expense row forces a rate lookup, which
        // is where the trap inserts the rival receipt-first transfer.
        var statementAccount = await SeedAccountAsync(db, owner, "Current", "USD");
        var counterparty = await SeedAccountAsync(db, owner, "Savings", "USD");

        var trap = new TrapRateProvider(async () =>
        {
            await using var rival = _fixture.CreateContext();
            rival.Transactions.Add(Transfer(owner, counterparty.Id, statementAccount.Id, null, new DateOnly(2026, 10, 1),
                receiptReference: "rcpt-race", currency: "USD"));
            await rival.SaveChangesAsync();
        });

        var handler = new CommitImportCommandHandler(db, new CurrentUserStub(owner), trap);
        var result = await handler.Handle(new CommitImportCommand(statementAccount.Id, new[]
        {
            new CommitImportItem("exp-1", new DateOnly(2026, 10, 1), "GROCER", 10m, "USD", IsCredit: false, null, null),
            new CommitImportItem("rcpt-race", new DateOnly(2026, 10, 1), "TRANSFER FROM SAVINGS", 100m, "USD", IsCredit: true, null, null,
                TransferAccountId: counterparty.Id),
        }), CancellationToken.None);

        result.Imported.Should().Be(1);
        result.SkippedDuplicates.Should().Be(1);
        result.Transfers.Should().Be(0);
        result.PendingReviewTransfers.Should().Be(0);

        await using var verify = _fixture.CreateContext();
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.ReceiptBankReference == "rcpt-race")).Should().Be(1);
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "exp-1")).Should().Be(1);
    }
}
