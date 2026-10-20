using System.Security.Cryptography;
using Microsoft.EntityFrameworkCore;

namespace AllotJar.Infrastructure.Persistence.Encryption;

/// <summary>
/// Brings every stored bank identifier onto the site's current key (compliance fix 10), run at
/// startup after the migrations: values saved before encryption are encrypted, and values written
/// with an older key (one moved to <c>PreviousKeys</c>, or the public development key) are
/// re-encrypted, so a retired key can be dropped after one start (a save alone never rewrites an
/// unchanged value). It reads the raw columns, so it sees the stored text rather than the
/// converter's output, and writes each column with its own conditional UPDATE
/// (<c>WHERE Id = @id AND Iban = @old</c>): a value the user changed meanwhile is left to the
/// user's save, which encrypts it anyway. Idempotent: a value under the current key is never
/// touched. It also counts values it cannot read (a key this site lacks, or damaged text), whose
/// account screens would fail, so startup can say so in the Event Log.
/// </summary>
public static class BankDetailsBackfill
{
    /// <param name="Encrypted">Plain values encrypted.</param>
    /// <param name="ReEncrypted">Values moved from an older key onto the current one.</param>
    /// <param name="FromDevelopmentKey">Of <paramref name="ReEncrypted"/>, those written with the public development key.</param>
    /// <param name="UnreadableKeyValues">Values this site cannot decrypt.</param>
    public sealed record Result(int Encrypted, int ReEncrypted, int FromDevelopmentKey, int UnreadableKeyValues);

    // The only bank columns; fixed names, never from input, so they are safe to put in SQL text.
    private static readonly string[] Columns = ["Iban", "Bic", "SortCode", "AccountNumber"];

    public static async Task<Result> BringToCurrentKeyAsync(ApplicationDbContext db, CancellationToken ct = default)
    {
        var rows = await db.Database
            .SqlQueryRaw<BankRow>(
                "SELECT Id, Iban, Bic, SortCode, AccountNumber FROM Accounts " +
                "WHERE Iban IS NOT NULL OR Bic IS NOT NULL OR SortCode IS NOT NULL OR AccountNumber IS NOT NULL")
            .ToListAsync(ct);

        var currentKeyId = BankDetailsCipher.CurrentKeyId;
        int encrypted = 0, reEncrypted = 0, fromDevelopmentKey = 0, unreadable = 0;
        foreach (var row in rows)
        {
            foreach (var column in Columns)
            {
                var stored = row.Get(column);
                if (stored is null)
                {
                    continue;
                }

                var name = $"Accounts.{column}";
                string plain;
                if (!BankDetailsCipher.IsEncrypted(stored))
                {
                    plain = stored;
                }
                else
                {
                    var keyId = BankDetailsCipher.KeyIdOf(stored);
                    if (keyId == currentKeyId)
                    {
                        continue;
                    }
                    try
                    {
                        plain = BankDetailsCipher.Unprotect(stored, name);
                    }
                    catch (Exception ex) when (ex is CryptographicException or FormatException)
                    {
                        unreadable++;
                        continue;
                    }
                }

                var updated = await WriteAsync(db, column, row.Id, stored, BankDetailsCipher.Protect(plain, name), ct);
                if (!BankDetailsCipher.IsEncrypted(stored))
                {
                    encrypted += updated;
                }
                else
                {
                    reEncrypted += updated;
                    if (BankDetailsCipher.KeyIdOf(stored) == BankDetailsCipher.DevelopmentKeyId)
                    {
                        fromDevelopmentKey += updated;
                    }
                }
            }
        }
        return new Result(encrypted, reEncrypted, fromDevelopmentKey, unreadable);
    }

    private static Task<int> WriteAsync(ApplicationDbContext db, string column, Guid id, string old, string value, CancellationToken ct)
    {
#pragma warning disable EF1002 // the column name is one of the four constants above
        return db.Database.ExecuteSqlRawAsync(
            $"UPDATE Accounts SET [{column}] = {{0}} WHERE Id = {{1}} AND [{column}] = {{2}}",
            [value, id, old], ct);
#pragma warning restore EF1002
    }

    private sealed class BankRow
    {
        public Guid Id { get; set; }
        public string? Iban { get; set; }
        public string? Bic { get; set; }
        public string? SortCode { get; set; }
        public string? AccountNumber { get; set; }

        public string? Get(string column) => column switch
        {
            "Iban" => Iban,
            "Bic" => Bic,
            "SortCode" => SortCode,
            "AccountNumber" => AccountNumber,
            _ => throw new ArgumentOutOfRangeException(nameof(column)),
        };
    }
}
