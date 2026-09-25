using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Relational guarantees for transfer bank legs that EF InMemory cannot see: the check
/// constraint refusing a transfer with no leg and the unique receipt-reference index on the
/// destination account. The commit's recovery when a concurrent commit confirms the same
/// receipt reference first lives in UniqueBankReferenceTests (the F6 inbound-transfer race).
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class TransferLegsSqlTests
{
    private readonly SqlServerFixture _fixture;

    public TransferLegsSqlTests(SqlServerFixture fixture) => _fixture = fixture;

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
}
