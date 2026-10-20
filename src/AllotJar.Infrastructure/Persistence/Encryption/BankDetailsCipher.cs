using System.Security.Cryptography;
using System.Text;

namespace AllotJar.Infrastructure.Persistence.Encryption;

/// <summary>
/// Encrypts an account's bank identifiers (IBAN, BIC, sort code, account number) at rest
/// (compliance fix 10). AES-256-GCM with a fresh 12-byte nonce per write, so the same IBAN never
/// gives the same stored text twice, and the column name as associated data, so a value copied
/// into another column does not decrypt. Stored form: <c>aj1:&lt;key id&gt;:&lt;base64 nonce|tag|ciphertext&gt;</c>.
///
/// The key is a dedicated 32-byte secret in each site's settings (<see cref="BankDetailsEncryption"/>),
/// not the Data Protection ring: that ring is DPAPI-locked to the VPS, so a backup restored on any
/// other machine would come back with every bank identifier unreadable. Older keys stay readable
/// through <c>PreviousKeys</c>; the key id in the stored text says which key wrote it.
///
/// Static because EF builds the model, and so the converters, once per process: a per-context
/// instance would be ignored after the first context anyway. Until a site key is configured the
/// public development key is used, which <see cref="BankDetailsEncryption.Configure"/> refuses
/// outside Development.
///
/// A stored value without the <c>aj1:</c> prefix is a row written before encryption and is read as
/// it is; the startup backfill (<see cref="BankDetailsBackfill"/>) encrypts those. No valid IBAN,
/// BIC, sort code or account number contains a colon, so the prefix cannot be mistaken for data.
/// Because every write gets a fresh nonce, a LINQ comparison against one of these columns
/// (<c>a.Iban == x</c>) can never match in SQL; compare after loading instead.
/// </summary>
public static class BankDetailsCipher
{
    public const string Prefix = "aj1:";

    private const int NonceSize = 12;
    private const int TagSize = 16;

    /// <summary>
    /// The development key: public (it is derived from this sentence), so it protects nothing.
    /// Used by local runs and the tests; refused on staging and production.
    /// </summary>
    public static readonly byte[] DevelopmentKey =
        SHA256.HashData(Encoding.UTF8.GetBytes("AllotJar development bank-details key; public, never used on a real site"));

    /// <summary>The development key's id, so startup can say when a real site re-encrypted values written with it.</summary>
    public static readonly string DevelopmentKeyId = KeyId(DevelopmentKey);

    private static volatile KeyRing _ring = new(DevelopmentKey, []);

    /// <summary>The key id of the key new values are written with (eight hex characters).</summary>
    public static string CurrentKeyId => _ring.CurrentId;

    /// <summary>
    /// Sets the key new values are written with and the retired keys that still read. Called once
    /// at startup by <see cref="BankDetailsEncryption.Configure"/>. Keys this process was given
    /// before stay readable: the integration tests boot several hosts in one process, and a host
    /// must not lose rows another host wrote. A real site configures once, so there it only keeps the
    /// public development key readable, which decrypts nothing that site wrote.
    /// </summary>
    public static void UseKeys(byte[] current, IReadOnlyList<byte[]> previous) =>
        _ring = new KeyRing(current, [.. previous, .. _ring.ById.Values]);

    /// <summary>Whether a stored value is already encrypted (as opposed to a pre-encryption row).</summary>
    public static bool IsEncrypted(string? stored) => stored is not null && stored.StartsWith(Prefix, StringComparison.Ordinal);

    /// <summary>The id of the key a stored value was written with, or null for a plain value.</summary>
    public static string? KeyIdOf(string? stored)
    {
        if (!IsEncrypted(stored)) return null;
        var end = stored!.IndexOf(':', Prefix.Length);
        return end < 0 ? null : stored[Prefix.Length..end];
    }

    /// <summary>Whether this site holds the key a stored value was written with (plain values: true).</summary>
    public static bool CanRead(string stored) =>
        !IsEncrypted(stored) || (KeyIdOf(stored) is { } id && _ring.ById.ContainsKey(id));

    public static string Protect(string plain, string column)
    {
        var ring = _ring;
        var data = Encoding.UTF8.GetBytes(plain);
        var blob = new byte[NonceSize + TagSize + data.Length];
        var nonce = blob.AsSpan(0, NonceSize);
        RandomNumberGenerator.Fill(nonce);
        using (var aes = new AesGcm(ring.Current, TagSize))
        {
            aes.Encrypt(nonce, data, blob.AsSpan(NonceSize + TagSize), blob.AsSpan(NonceSize, TagSize), Aad(column));
        }
        return $"{Prefix}{ring.CurrentId}:{Convert.ToBase64String(blob)}";
    }

    public static string Unprotect(string stored, string column)
    {
        if (!IsEncrypted(stored))
        {
            return stored;
        }

        var ring = _ring;
        var end = stored.IndexOf(':', Prefix.Length);
        if (end < 0)
        {
            throw new CryptographicException($"A stored {column} value is not in the aj1 format.");
        }
        var keyId = stored[Prefix.Length..end];
        if (!ring.ById.TryGetValue(keyId, out var key))
        {
            throw new CryptographicException(
                $"A stored {column} value was encrypted with key {keyId}, which this site does not have " +
                $"(it writes with {ring.CurrentId}). Add that key to BankDetailsEncryption:PreviousKeys, or set " +
                "BankDetailsEncryption:Key to the key this database was written with.");
        }

        var blob = Convert.FromBase64String(stored[(end + 1)..]);
        if (blob.Length < NonceSize + TagSize)
        {
            throw new CryptographicException($"A stored {column} value is too short to be encrypted data.");
        }
        var data = new byte[blob.Length - NonceSize - TagSize];
        using (var aes = new AesGcm(key, TagSize))
        {
            aes.Decrypt(blob.AsSpan(0, NonceSize), blob.AsSpan(NonceSize + TagSize), blob.AsSpan(NonceSize, TagSize), data, Aad(column));
        }
        return Encoding.UTF8.GetString(data);
    }

    /// <summary>The first four bytes of the key's SHA-256, in hex: names a key without revealing it.</summary>
    public static string KeyId(byte[] key) => Convert.ToHexStringLower(SHA256.HashData(key).AsSpan(0, 4));

    private static byte[] Aad(string column) => Encoding.UTF8.GetBytes(column);

    private sealed class KeyRing
    {
        public KeyRing(byte[] current, IReadOnlyList<byte[]> previous)
        {
            Current = current;
            CurrentId = KeyId(current);
            ById = new Dictionary<string, byte[]>(StringComparer.Ordinal) { [CurrentId] = current };
            foreach (var key in previous)
            {
                ById.TryAdd(KeyId(key), key);
            }
        }

        public byte[] Current { get; }
        public string CurrentId { get; }
        public Dictionary<string, byte[]> ById { get; }
    }
}
