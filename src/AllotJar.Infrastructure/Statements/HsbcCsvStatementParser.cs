using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Parses HSBC personal-banking "transaction history" CSV exports. These have no header
/// and three columns: <c>Date, Details, Amount</c>. The free-text <c>Details</c> column packs
/// four sub-fields: <c>&lt;description&gt; [*] &lt;purchase date dd/MM/yyyy&gt; •••• •••• •••• &lt;last4&gt; &lt;signed amount&gt; &lt;CCY&gt;</c>.
///
/// The export carries no per-line bank reference, so to keep re-imports idempotent we synthesise a
/// deterministic <see cref="ParsedStatementEntry.Reference"/> from the row's stable fields and append a
/// per-signature occurrence index — that way genuinely-repeated identical charges (e.g. four equal
/// payments on one day) are all imported, while re-importing the same dump is a no-op.
/// </summary>
public partial class HsbcCsvStatementParser : IStatementParser
{
    public StatementFormat Format => StatementFormat.HsbcCsv;

    // Anchors on the strong dd/MM/yyyy purchase-date token and the trailing "<amount> <CCY>". The
    // optional "*" separator and any "*" inside merchant names (PAYPAL *TEMU, REVOLUT**0573*) are
    // absorbed by the non-greedy description and the optional '\*?' before the date.
    [GeneratedRegex(
        @"^(?<desc>.*?)\s*\*?\s+(?<pdate>\d{2}/\d{2}/\d{4})\s+(?<mask>.*?)\s+(?<amt>-?[\d,]+\.\d{2})\s+(?<ccy>[A-Z]{3})\s*$",
        RegexOptions.CultureInvariant)]
    private static partial Regex DetailsPattern();

    [GeneratedRegex(@"(\d{4})\D*$", RegexOptions.CultureInvariant)]
    private static partial Regex Last4Pattern();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRun();

    /// <summary>
    /// Sniff whether the content is an HSBC transaction-history CSV: comma-separated rows whose
    /// first column is a dd/MM/yyyy date and whose Details column carries the packed
    /// "&lt;description&gt; &lt;purchase date&gt; &lt;card mask&gt; &lt;amount&gt; &lt;CCY&gt;" shape. Requires most data
    /// rows (≥80% of the first 50) to match, so a generic CSV that merely contains dates won't
    /// be misrouted here.
    /// </summary>
    public bool CanParse(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return false;
        }

        int dataRows = 0, detailRows = 0;
        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (line.Length == 0)
            {
                continue;
            }

            // Sniffing is stricter than Parse: exactly the 3-column Date,Details,Amount shape.
            // A wider export that merely embeds HSBC-like narratives must fall through to the
            // generic mapping UI instead of being hijacked with the wrong amount column.
            var fields = SplitCsvLine(line);
            if (fields.Count != 3 || !TryParseDate(fields[0], out _))
            {
                continue; // header, footer or blank
            }

            dataRows++;
            if (DetailsPattern().IsMatch(fields[1].Trim()))
            {
                detailRows++;
            }
            if (dataRows >= 50)
            {
                break; // a sample is plenty — don't scan a 10 MB file twice
            }
        }

        return dataRows > 0 && detailRows * 5 >= dataRows * 4; // ≥ 80%
    }

    public ParsedStatement Parse(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            throw new StatementParseException("The CSV file is empty.");
        }

        var entries = new List<ParsedStatementEntry>();
        // Per-signature occurrence counter, so the Nth identical row gets a distinct reference.
        var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var rawLine in content.Split('\n'))
        {
            var line = rawLine.TrimEnd('\r');
            if (line.Length == 0)
            {
                continue;
            }

            var fields = SplitCsvLine(line);
            // A data row is "postingDate, details, amount". Anything whose first column isn't a
            // dd/MM/yyyy date (a header, a blank line, a totals footer) is skipped.
            if (fields.Count < 3 || !TryParseDate(fields[0], out var postingDate))
            {
                continue;
            }

            var details = fields[1].Trim();
            if (!TryParseSignedAmount(fields[2], out var signedAmount))
            {
                // Fall back to the amount embedded in Details if column 3 is unusable.
                var inlineMatch = DetailsPattern().Match(details);
                if (!inlineMatch.Success || !TryParseSignedAmount(inlineMatch.Groups["amt"].Value, out signedAmount))
                {
                    continue; // no amount we can trust — not a transaction we can import
                }
            }

            var (description, purchaseDate, last4, currency) = ParseDetails(details, postingDate);

            var signature = string.Create(CultureInfo.InvariantCulture,
                $"{postingDate:yyyy-MM-dd}|{purchaseDate:yyyy-MM-dd}|{last4}|{signedAmount:0.00}|{description.ToUpperInvariant()}");
            var hash = ShortHash(signature);
            var index = occurrences.TryGetValue(signature, out var seen) ? seen : 0;
            occurrences[signature] = index + 1;
            var reference = $"hsbc:{hash}#{index}";

            entries.Add(new ParsedStatementEntry(
                Amount: Math.Abs(signedAmount),
                Currency: currency,
                IsCredit: signedAmount > 0,
                BookingDate: purchaseDate,
                Payee: description,
                Reference: reference));
        }

        if (entries.Count == 0)
        {
            throw new StatementParseException(
                "No transactions were found — is this an HSBC transaction-history CSV (Date, Details, Amount)?");
        }

        // HSBC's CSV carries no account/IBAN.
        return new ParsedStatement(Iban: null, Entries: entries);
    }

    /// <summary>
    /// Pull the description, purchase date, card last-4 and currency out of the Details text.
    /// When the line doesn't match the expected shape we keep the whole text as the description
    /// and fall back to the row's posting date, so no row is silently dropped.
    /// </summary>
    private static (string Description, DateOnly PurchaseDate, string Last4, string Currency) ParseDetails(
        string details, DateOnly postingDate)
    {
        var match = DetailsPattern().Match(details);
        if (!match.Success)
        {
            return (Normalize(details), postingDate, string.Empty, "EUR");
        }

        var description = Normalize(match.Groups["desc"].Value);
        var purchaseDate = TryParseDate(match.Groups["pdate"].Value, out var pd) ? pd : postingDate;
        var last4Match = Last4Pattern().Match(match.Groups["mask"].Value);
        var last4 = last4Match.Success ? last4Match.Groups[1].Value : string.Empty;
        var currency = match.Groups["ccy"].Value.ToUpperInvariant();

        return (description, purchaseDate, last4, currency);
    }

    /// <summary>
    /// Shared cleaner: pull just the merchant description out of an HSBC-style packed Details
    /// blob ("&lt;description&gt; &lt;purchase date&gt; &lt;card mask&gt; &lt;amount&gt; &lt;CCY&gt;"). Used by the generic
    /// CSV importer too, so a stray HSBC-shaped description cell still surfaces a clean payee.
    /// Returns false (and an empty description) when the text isn't in that shape.
    /// </summary>
    internal static bool TryCleanDetails(string text, out string description)
    {
        var match = DetailsPattern().Match(text);
        description = match.Success ? Normalize(match.Groups["desc"].Value) : string.Empty;
        return match.Success && description.Length > 0;
    }

    /// <summary>First 128 bits of SHA-256 over the signature, as 32 lowercase hex chars.</summary>
    private static string ShortHash(string signature)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(signature));
        return Convert.ToHexString(bytes, 0, 16).ToLowerInvariant();
    }

    private static string Normalize(string value) =>
        WhitespaceRun().Replace(value, " ").Trim();

    private static bool TryParseDate(string value, out DateOnly date) =>
        DateOnly.TryParseExact(value.Trim(), "dd/MM/yyyy", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out date);

    private static bool TryParseSignedAmount(string value, out decimal amount) =>
        decimal.TryParse(value.Trim(), NumberStyles.Number, CultureInfo.InvariantCulture, out amount);

    /// <summary>
    /// Minimal RFC-4180 line splitter: most rows are plain, but rows with thousands separators are
    /// quoted (e.g. <c>"-1,770.00 EUR","-1,770.00"</c>), so a naive comma split would corrupt them.
    /// Assumes one record per line (HSBC never embeds newlines inside a quoted field).
    /// </summary>
    private static List<string> SplitCsvLine(string line)
    {
        var fields = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;

        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (inQuotes)
            {
                if (c == '"')
                {
                    if (i + 1 < line.Length && line[i + 1] == '"')
                    {
                        sb.Append('"'); // escaped quote
                        i++;
                    }
                    else
                    {
                        inQuotes = false;
                    }
                }
                else
                {
                    sb.Append(c);
                }
            }
            else if (c == '"')
            {
                inQuotes = true;
            }
            else if (c == ',')
            {
                fields.Add(sb.ToString());
                sb.Clear();
            }
            else
            {
                sb.Append(c);
            }
        }

        fields.Add(sb.ToString());
        return fields;
    }
}
