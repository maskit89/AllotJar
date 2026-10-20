using Microsoft.EntityFrameworkCore;

namespace AllotJar.Infrastructure.Persistence.Encryption;

/// <summary>
/// Encrypts the bank identifiers of accounts saved before encryption (compliance fix 10), run at
/// startup after the migrations. It reads the raw columns, so it sees the stored text rather than
/// the converter's output, and writes each column with its own conditional UPDATE
/// (<c>WHERE Id = @id AND Iban = @plain</c>): a value the user changed meanwhile is left to the
/// user's save, which encrypts it anyway. Idempotent: an encrypted value is never touched again.
/// It also counts values written with a key this site does not have, which the account screens
/// would fail to read, so startup can say so in the Event Log.
/// </summary>
public static class BankDetailsBackfill
{
    public sealed record Result(int Encrypted, int UnreadableKeyValues);

    // The only bank columns; fixed names, never from input, so they are safe to put in SQL text.
    private static readonly string[] Columns = ["Iban", "Bic", "SortCode", "AccountNumber"];

    public static async Task<Result> EncryptPlaintextAsync(ApplicationDbContext db, CancellationToken ct = default)
    {
        var rows = await db.Database
            .SqlQueryRaw<BankRow>(
                "SELECT Id, Iban, Bic, SortCode, AccountNumber FROM Accounts " +
                "WHERE Iban IS NOT NULL OR Bic IS NOT NULL OR SortCode IS NOT NULL OR AccountNumber IS NOT NULL")
            .ToListAsync(ct);

        var encrypted = 0;
        var unreadable = 0;
        foreach (var row in rows)
        {
            foreach (var column in Columns)
            {
                var stored = row.Get(column);
                if (stored is null)
                {
                    continue;
                }
                if (BankDetailsCipher.IsEncrypted(stored))
                {
                    if (!BankDetailsCipher.CanRead(stored))
                    {
                        unreadable++;
                    }
                    continue;
                }

                var cipher = BankDetailsCipher.Protect(stored, $"Accounts.{column}");
#pragma warning disable EF1002 // the column name is one of the four constants above
                encrypted += await db.Database.ExecuteSqlRawAsync(
                    $"UPDATE Accounts SET [{column}] = {{0}} WHERE Id = {{1}} AND [{column}] = {{2}}",
                    [cipher, row.Id, stored], ct);
#pragma warning restore EF1002
            }
        }
        return new Result(encrypted, unreadable);
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
