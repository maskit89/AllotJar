using Microsoft.Extensions.Configuration;

namespace AllotJar.Infrastructure.Persistence.Encryption;

/// <summary>
/// Reads the bank-details key from configuration and hands it to <see cref="BankDetailsCipher"/>.
/// <c>BankDetailsEncryption:Key</c> is 32 random bytes in base64 (each site its own, a copy in the
/// owner's password manager); <c>BankDetailsEncryption:PreviousKeys</c> optionally lists retired
/// keys that still decrypt older rows. Outside Development a missing, malformed or development key
/// stops the API at startup rather than writing bank details with a key anyone can read.
/// </summary>
public static class BankDetailsEncryption
{
    public const string SectionName = "BankDetailsEncryption";

    public static void Configure(IConfiguration configuration, bool isDevelopment)
    {
        var section = configuration.GetSection(SectionName);
        var keyText = section["Key"];
        if (string.IsNullOrWhiteSpace(keyText))
        {
            if (!isDevelopment)
            {
                throw new InvalidOperationException(
                    "BankDetailsEncryption:Key is not configured. Every site outside Development needs its own " +
                    "32-byte key (base64) to encrypt bank details at rest; see docs/deployment/README.md.");
            }
            BankDetailsCipher.UseKeys(BankDetailsCipher.DevelopmentKey, []);
            return;
        }

        var current = Parse(keyText, "BankDetailsEncryption:Key");
        if (!isDevelopment && current.AsSpan().SequenceEqual(BankDetailsCipher.DevelopmentKey))
        {
            throw new InvalidOperationException(
                "BankDetailsEncryption:Key is the public development key; give this site a key of its own.");
        }

        var previous = section.GetSection("PreviousKeys").GetChildren()
            .Where(c => !string.IsNullOrWhiteSpace(c.Value))
            .Select(c => Parse(c.Value!, $"BankDetailsEncryption:PreviousKeys:{c.Key}"))
            .ToList();

        BankDetailsCipher.UseKeys(current, previous);
    }

    private static byte[] Parse(string text, string name)
    {
        byte[] key;
        try
        {
            key = Convert.FromBase64String(text.Trim());
        }
        catch (FormatException)
        {
            throw new InvalidOperationException($"{name} is not base64.");
        }
        if (key.Length != 32)
        {
            throw new InvalidOperationException($"{name} must be 32 bytes (44 base64 characters); it is {key.Length}.");
        }
        return key;
    }
}
