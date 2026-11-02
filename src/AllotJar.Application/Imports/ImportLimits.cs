using System.Globalization;

namespace AllotJar.Application.Imports;

/// <summary>
/// How much one statement import may hold. Committing checks every row against the account's
/// balance on each day, with the account's ledger locked, and the time that takes grows faster
/// than the rows: on a test machine 3,000 rows took about 7 s, 5,000 about 17 s and 10,000 about
/// a minute. The server has one CPU for production, staging and SQL Server, so a bigger
/// statement is imported in parts (a shorter date range from the bank).
/// </summary>
public static class ImportLimits
{
    /// <summary>The most new rows one preview offers, and one commit takes (more than a year of most accounts).</summary>
    public const int MaxRows = 2_500;

    /// <summary>
    /// The largest commit body. A plain row is about 150 bytes of JSON and a split one with jar
    /// amounts well under 1 KB, so 2,500 rows fit with room to spare.
    /// </summary>
    public const long MaxCommitBytes = 4 * 1024 * 1024;

    /// <summary>
    /// How long a commit may run before it is stopped and nothing of it is saved: well over what
    /// <see cref="MaxRows"/> rows take, and well under how long Cloudflare (100 s) and IIS ARR wait for
    /// the API, so the browser gets this answer rather than the proxy's.
    /// </summary>
    public static readonly TimeSpan CommitTimeLimit = TimeSpan.FromSeconds(30);

    public static string TooManyRows(int rows) => string.Create(CultureInfo.InvariantCulture,
        $"This statement has {rows:N0} new rows, and up to {MaxRows:N0} are imported at a time. Export a shorter date range from your bank and import it in parts.");
}
