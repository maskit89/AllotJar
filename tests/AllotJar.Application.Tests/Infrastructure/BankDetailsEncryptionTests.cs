using System.Security.Cryptography;
using System.Text;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using AllotJar.Domain.Entities;
using AllotJar.Infrastructure.Persistence.Encryption;
using Xunit;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// Compliance fix 10: an account's IBAN, BIC, sort code and account number are encrypted at rest
/// with the site's own key, read back unchanged, and a row saved before encryption still reads.
/// The SQL suite (BankDetailsEncryptionSqlTests) pins the stored column text and the backfill.
/// </summary>
public class BankDetailsEncryptionTests
{
    private const string Iban = "MT84MALT011000012345MTLCAST001S";

    private static byte[] RandomKey() => RandomNumberGenerator.GetBytes(32);

    private static IConfiguration Config(params (string Key, string? Value)[] values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value)))
            .Build();

    // --- Cipher ----------------------------------------------------------------------------------

    [Fact]
    public void A_value_round_trips_and_never_shows_in_its_stored_form()
    {
        var stored = BankDetailsCipher.Protect(Iban, "Accounts.Iban");

        stored.Should().StartWith(BankDetailsCipher.Prefix);
        stored.Should().NotContain(Iban).And.NotContain("MALT");
        BankDetailsCipher.Unprotect(stored, "Accounts.Iban").Should().Be(Iban);
    }

    [Fact]
    public void The_same_value_is_stored_differently_each_time()
    {
        BankDetailsCipher.Protect(Iban, "Accounts.Iban")
            .Should().NotBe(BankDetailsCipher.Protect(Iban, "Accounts.Iban"), "each write takes a fresh nonce");
    }

    [Fact]
    public void A_value_moved_to_another_column_does_not_decrypt()
    {
        var stored = BankDetailsCipher.Protect("12345678", "Accounts.AccountNumber");

        var read = () => BankDetailsCipher.Unprotect(stored, "Accounts.SortCode");
        read.Should().Throw<CryptographicException>("the column name is authenticated with the value");
    }

    [Fact]
    public void A_tampered_value_is_refused_rather_than_read_as_something_else()
    {
        var stored = BankDetailsCipher.Protect(Iban, "Accounts.Iban");
        var blob = Convert.FromBase64String(stored[(stored.LastIndexOf(':') + 1)..]);
        blob[^1] ^= 1;
        var tampered = stored[..(stored.LastIndexOf(':') + 1)] + Convert.ToBase64String(blob);

        var read = () => BankDetailsCipher.Unprotect(tampered, "Accounts.Iban");
        read.Should().Throw<CryptographicException>();
    }

    [Fact]
    public void A_value_saved_before_encryption_reads_as_it_is()
    {
        BankDetailsCipher.IsEncrypted(Iban).Should().BeFalse();
        BankDetailsCipher.Unprotect(Iban, "Accounts.Iban").Should().Be(Iban);
        BankDetailsCipher.CanRead(Iban).Should().BeTrue();
    }

    [Fact]
    public void A_value_written_with_a_key_this_site_lacks_names_that_key_and_does_not_read()
    {
        // Written by hand with a key the process never saw, in the aj1 format.
        var key = RandomKey();
        var nonce = RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(Iban);
        var blob = new byte[12 + 16 + data.Length];
        nonce.CopyTo(blob, 0);
        using (var aes = new AesGcm(key, 16))
        {
            aes.Encrypt(nonce, data, blob.AsSpan(28), blob.AsSpan(12, 16), Encoding.UTF8.GetBytes("Accounts.Iban"));
        }
        var keyId = BankDetailsCipher.KeyId(key);
        var stored = $"aj1:{keyId}:{Convert.ToBase64String(blob)}";

        BankDetailsCipher.KeyIdOf(stored).Should().Be(keyId);
        BankDetailsCipher.CanRead(stored).Should().BeFalse();
        var read = () => BankDetailsCipher.Unprotect(stored, "Accounts.Iban");
        read.Should().Throw<CryptographicException>().WithMessage($"*{keyId}*PreviousKeys*");
    }

    [Fact]
    public void After_a_key_change_values_written_with_the_previous_key_still_read()
    {
        var oldKey = RandomKey();
        var newKey = RandomKey();
        try
        {
            BankDetailsCipher.UseKeys(oldKey, []);
            var written = BankDetailsCipher.Protect(Iban, "Accounts.Iban");

            BankDetailsCipher.UseKeys(newKey, [oldKey]);

            BankDetailsCipher.CurrentKeyId.Should().Be(BankDetailsCipher.KeyId(newKey));
            BankDetailsCipher.Unprotect(written, "Accounts.Iban").Should().Be(Iban);
            BankDetailsCipher.KeyIdOf(BankDetailsCipher.Protect(Iban, "Accounts.Iban"))
                .Should().Be(BankDetailsCipher.KeyId(newKey), "new values use the new key");
        }
        finally
        {
            BankDetailsCipher.UseKeys(BankDetailsCipher.DevelopmentKey, []);
        }
    }

    // --- Configuration ---------------------------------------------------------------------------

    [Fact]
    public void Outside_development_the_api_will_not_start_without_a_key()
    {
        var configure = () => BankDetailsEncryption.Configure(Config(), isDevelopment: false);
        configure.Should().Throw<InvalidOperationException>().WithMessage("*BankDetailsEncryption:Key is not configured*");
    }

    [Fact]
    public void Outside_development_the_public_development_key_is_refused()
    {
        var configure = () => BankDetailsEncryption.Configure(
            Config(("BankDetailsEncryption:Key", Convert.ToBase64String(BankDetailsCipher.DevelopmentKey))), isDevelopment: false);
        configure.Should().Throw<InvalidOperationException>().WithMessage("*public development key*");
    }

    [Theory]
    [InlineData("not base64!", "*not base64*")]
    [InlineData("AAAA", "*must be 32 bytes*")]
    public void A_malformed_key_is_refused(string key, string message)
    {
        var configure = () => BankDetailsEncryption.Configure(Config(("BankDetailsEncryption:Key", key)), isDevelopment: false);
        configure.Should().Throw<InvalidOperationException>().WithMessage(message);
    }

    [Fact]
    public void A_site_key_and_its_previous_keys_are_taken_from_configuration()
    {
        var key = RandomKey();
        var retired = RandomKey();
        try
        {
            BankDetailsCipher.UseKeys(retired, []);
            var old = BankDetailsCipher.Protect(Iban, "Accounts.Iban");

            BankDetailsEncryption.Configure(Config(
                ("BankDetailsEncryption:Key", Convert.ToBase64String(key)),
                ("BankDetailsEncryption:PreviousKeys:0", Convert.ToBase64String(retired))), isDevelopment: false);

            BankDetailsCipher.CurrentKeyId.Should().Be(BankDetailsCipher.KeyId(key));
            BankDetailsCipher.Unprotect(old, "Accounts.Iban").Should().Be(Iban);
        }
        finally
        {
            BankDetailsCipher.UseKeys(BankDetailsCipher.DevelopmentKey, []);
        }
    }

    // --- Through EF --------------------------------------------------------------------------------

    [Fact]
    public async Task An_account_saves_its_bank_details_encrypted_and_reads_them_back_plain()
    {
        var db = NewContext();
        var account = new Account
        {
            OwnerId = "owner-1", Name = "Current",
            Iban = Iban, Bic = "MALTMTMT", SortCode = "123456", AccountNumber = "12345678",
        };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        db.ChangeTracker.Clear();

        var read = await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id);
        read.Iban.Should().Be(Iban);
        read.Bic.Should().Be("MALTMTMT");
        read.SortCode.Should().Be("123456");
        read.AccountNumber.Should().Be("12345678");

        var model = db.Model.FindEntityType(typeof(Account))!;
        foreach (var name in new[] { nameof(Account.Iban), nameof(Account.Bic), nameof(Account.SortCode), nameof(Account.AccountNumber) })
        {
            var converter = model.FindProperty(name)!.GetValueConverter();
            converter.Should().NotBeNull($"{name} is encrypted at rest");
            ((string)converter!.ConvertToProvider("X1")!).Should().StartWith(BankDetailsCipher.Prefix);
        }
    }
}
