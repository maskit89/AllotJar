using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Persistence.Encryption;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Compliance fix 10 on the real schema: the four bank columns hold only encrypted text, which
/// fits the widened columns, and the startup backfill encrypts rows saved before encryption
/// without changing what they read as.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class BankDetailsEncryptionSqlTests
{
    private const string LongestIban = "MT84MALT011000012345MTLCAST001SABC"; // 34 characters, the IBAN maximum
    private readonly SqlServerFixture _fixture;

    public BankDetailsEncryptionSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static Account NewAccount(string owner) => new()
    {
        OwnerId = owner, Name = "Current", Type = AccountType.Current, Currency = CurrencyCode.Eur,
        OpeningBalance = 0m, OpeningDate = new DateOnly(2026, 1, 1),
        Iban = LongestIban, Bic = "MALTMTMTXXX", SortCode = "123456", AccountNumber = "1234567890123456789012345678901234",
    };

    private static async Task<string?[]> StoredAsync(ApplicationDbContext db, Guid id) =>
        (await db.Database
            .SqlQuery<StoredRow>($"SELECT Iban, Bic, SortCode, AccountNumber FROM Accounts WHERE Id = {id}")
            .SingleAsync()).All;

    private sealed class StoredRow
    {
        public string? Iban { get; set; }
        public string? Bic { get; set; }
        public string? SortCode { get; set; }
        public string? AccountNumber { get; set; }
        public string?[] All => [Iban, Bic, SortCode, AccountNumber];
    }

    [Fact]
    public async Task The_longest_bank_details_are_stored_encrypted_and_read_back_plain()
    {
        var account = NewAccount($"user-{Guid.NewGuid():N}");
        await using (var db = _fixture.CreateContext())
        {
            db.Accounts.Add(account);
            await db.SaveChangesAsync();
        }

        await using (var db = _fixture.CreateContext())
        {
            var stored = await StoredAsync(db, account.Id);
            stored.Should().AllSatisfy(s => s.Should().StartWith(BankDetailsCipher.Prefix));
            stored[0].Should().NotContain("MALT");
            stored[3].Should().NotContain("12345678");
            stored.Max(s => s!.Length).Should().BeLessThanOrEqualTo(150, "the 256-character columns leave room");

            var read = await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id);
            read.Iban.Should().Be(LongestIban);
            read.Bic.Should().Be("MALTMTMTXXX");
            read.SortCode.Should().Be("123456");
            read.AccountNumber.Should().Be("1234567890123456789012345678901234");
        }
    }

    [Fact]
    public async Task The_backfill_encrypts_a_row_saved_before_encryption_and_leaves_it_reading_the_same()
    {
        var account = NewAccount($"user-{Guid.NewGuid():N}");
        account.Bic = null; // a column left empty stays empty
        await using (var db = _fixture.CreateContext())
        {
            db.Accounts.Add(account);
            await db.SaveChangesAsync();
            // As a row saved before this change looks: plain text in the columns.
            await db.Database.ExecuteSqlAsync(
                $"UPDATE Accounts SET Iban = {LongestIban}, SortCode = '123456', AccountNumber = '12345678' WHERE Id = {account.Id}");
        }

        await using (var db = _fixture.CreateContext())
        {
            (await StoredAsync(db, account.Id)).Should().Equal(LongestIban, null, "123456", "12345678");
            (await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id)).Iban
                .Should().Be(LongestIban, "a plain row still reads before the backfill runs");

            var result = await BankDetailsBackfill.EncryptPlaintextAsync(db);
            result.Encrypted.Should().BeGreaterThanOrEqualTo(3);
        }

        string?[] afterFirst;
        await using (var db = _fixture.CreateContext())
        {
            afterFirst = await StoredAsync(db, account.Id);
            afterFirst[0].Should().StartWith(BankDetailsCipher.Prefix);
            afterFirst[1].Should().BeNull();
            afterFirst[2].Should().StartWith(BankDetailsCipher.Prefix);
            afterFirst[3].Should().StartWith(BankDetailsCipher.Prefix);

            var read = await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id);
            read.Iban.Should().Be(LongestIban);
            read.Bic.Should().BeNull();
            read.SortCode.Should().Be("123456");
            read.AccountNumber.Should().Be("12345678");

            await BankDetailsBackfill.EncryptPlaintextAsync(db);
        }

        await using (var db = _fixture.CreateContext())
        {
            (await StoredAsync(db, account.Id)).Should().Equal(afterFirst, "an encrypted value is never rewritten");
        }
    }
}
