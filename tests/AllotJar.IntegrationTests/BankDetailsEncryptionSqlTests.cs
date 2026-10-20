using System.Security.Cryptography;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Persistence.Encryption;
using AllotJar.IntegrationTests.Http;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Compliance fix 10 on the real schema: the four bank columns hold only encrypted text, which
/// fits the widened columns, and the startup backfill encrypts rows saved before encryption and
/// moves values off a retired key, without changing what they read as.
///
/// In the HTTP collection, not the SQL one, on purpose: these tests and the staging-host test in
/// DirectInviteFirstSignInTests change the process-wide key, so they must not run alongside each other.
/// </summary>
[Collection(nameof(HttpApiCollection))]
public class BankDetailsEncryptionSqlTests
{
    private const string LongestIban = "MT84MALT011000012345MTLCAST001SABC"; // 34 characters, the IBAN maximum
    private readonly HttpApiFixture _fixture;

    public BankDetailsEncryptionSqlTests(HttpApiFixture fixture) => _fixture = fixture;

    private sealed class Scoped : IAsyncDisposable
    {
        private readonly AsyncServiceScope _scope;
        public Scoped(IServiceProvider services)
        {
            _scope = services.CreateAsyncScope();
            Db = _scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        }
        public ApplicationDbContext Db { get; }
        public ValueTask DisposeAsync() => _scope.DisposeAsync();
    }

    private Scoped Context() => new(_fixture.Services);

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

    private static async Task<Account> ReadAsync(ApplicationDbContext db, Guid id) =>
        await db.Accounts.IgnoreQueryFilters().AsNoTracking().SingleAsync(a => a.Id == id);

    [Fact]
    public async Task The_longest_bank_details_are_stored_encrypted_and_read_back_plain()
    {
        var account = NewAccount($"user-{Guid.NewGuid():N}");
        await using (var s = Context())
        {
            s.Db.Accounts.Add(account);
            await s.Db.SaveChangesAsync();
        }

        await using (var s = Context())
        {
            var stored = await StoredAsync(s.Db, account.Id);
            stored.Should().AllSatisfy(v => v.Should().StartWith(BankDetailsCipher.Prefix));
            stored[0].Should().NotContain("MALT");
            stored[3].Should().NotContain("12345678");
            stored.Max(v => v!.Length).Should().BeLessThanOrEqualTo(150, "the 256-character columns leave room");

            var read = await ReadAsync(s.Db, account.Id);
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
        await using (var s = Context())
        {
            s.Db.Accounts.Add(account);
            await s.Db.SaveChangesAsync();
            // As a row saved before this change looks: plain text in the columns.
            await s.Db.Database.ExecuteSqlAsync(
                $"UPDATE Accounts SET Iban = {LongestIban}, SortCode = '123456', AccountNumber = '12345678' WHERE Id = {account.Id}");
        }

        await using (var s = Context())
        {
            (await StoredAsync(s.Db, account.Id)).Should().Equal(LongestIban, null, "123456", "12345678");
            (await ReadAsync(s.Db, account.Id)).Iban.Should().Be(LongestIban, "a plain row still reads before the backfill runs");

            var result = await BankDetailsBackfill.BringToCurrentKeyAsync(s.Db);
            result.Encrypted.Should().BeGreaterThanOrEqualTo(3);
        }

        string?[] afterFirst;
        await using (var s = Context())
        {
            afterFirst = await StoredAsync(s.Db, account.Id);
            afterFirst[0].Should().StartWith(BankDetailsCipher.Prefix);
            afterFirst[1].Should().BeNull();
            afterFirst[2].Should().StartWith(BankDetailsCipher.Prefix);
            afterFirst[3].Should().StartWith(BankDetailsCipher.Prefix);

            var read = await ReadAsync(s.Db, account.Id);
            read.Iban.Should().Be(LongestIban);
            read.Bic.Should().BeNull();
            read.SortCode.Should().Be("123456");
            read.AccountNumber.Should().Be("12345678");

            await BankDetailsBackfill.BringToCurrentKeyAsync(s.Db);
        }

        await using (var s = Context())
        {
            (await StoredAsync(s.Db, account.Id)).Should().Equal(afterFirst, "a value under the current key is never rewritten");
        }
    }

    [Fact]
    public async Task After_a_key_change_the_backfill_moves_every_value_to_the_new_key_so_the_old_one_can_go()
    {
        var oldKey = RandomNumberGenerator.GetBytes(32);
        var newKey = RandomNumberGenerator.GetBytes(32);
        var account = NewAccount($"user-{Guid.NewGuid():N}");
        try
        {
            BankDetailsCipher.UseKeys(oldKey, []);
            await using (var s = Context())
            {
                s.Db.Accounts.Add(account);
                await s.Db.SaveChangesAsync();
                (await StoredAsync(s.Db, account.Id)).Should().AllSatisfy(v => BankDetailsCipher.KeyIdOf(v).Should().Be(BankDetailsCipher.KeyId(oldKey)));
            }

            // The README's rotation: the old key moves to PreviousKeys, the new one becomes Key, the site starts.
            BankDetailsCipher.UseKeys(newKey, [oldKey]);
            await using (var s = Context())
            {
                // Renaming the account alone does not rewrite its unchanged bank details.
                var tracked = await s.Db.Accounts.IgnoreQueryFilters().SingleAsync(a => a.Id == account.Id);
                tracked.Name = "Renamed";
                await s.Db.SaveChangesAsync();
                (await StoredAsync(s.Db, account.Id)).Should().AllSatisfy(v => BankDetailsCipher.KeyIdOf(v).Should().Be(BankDetailsCipher.KeyId(oldKey)));

                var result = await BankDetailsBackfill.BringToCurrentKeyAsync(s.Db);
                result.ReEncrypted.Should().BeGreaterThanOrEqualTo(4);
            }

            await using (var s = Context())
            {
                (await StoredAsync(s.Db, account.Id)).Should().AllSatisfy(v => BankDetailsCipher.KeyIdOf(v).Should().Be(BankDetailsCipher.KeyId(newKey)));
                var read = await ReadAsync(s.Db, account.Id);
                read.Iban.Should().Be(LongestIban);
                read.AccountNumber.Should().Be("1234567890123456789012345678901234");
            }
        }
        finally
        {
            BankDetailsCipher.UseKeys(BankDetailsCipher.DevelopmentKey, []);
        }
    }
}
