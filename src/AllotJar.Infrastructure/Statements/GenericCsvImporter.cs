using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;

namespace AllotJar.Infrastructure.Statements;

/// <summary>
/// Imports a generic bank-CSV export. Because CSV layouts vary wildly, this works in two steps:
/// <see cref="Detect"/> sniffs the delimiter, header and a best-guess column mapping (returned to
/// the user to confirm/correct), and <see cref="Parse"/> reads the file with the confirmed mapping.
/// The export carries no stable per-row id, so — like the HSBC parser — a deterministic reference is
/// synthesised from the row's fields plus an occurrence index, keeping re-imports idempotent while
/// still importing genuinely-repeated identical charges.
/// </summary>
public sealed partial class GenericCsvImporter : ICsvImporter
{
    private static readonly char[] CandidateDelimiters = { ',', ';', '\t', '|' };

    // Tried in order when a row's date format isn't pinned. ISO first; dd/MM before MM/dd (the app's
    // European roots) — an ambiguous "03/04/2026" is why the UI also offers an explicit format.
    // Two-digit-year variants sit AFTER their four-digit peers: TryParseExact is length-strict, so
    // they can never steal a match from a four-digit file — they only rescue "12/03/26"-style exports
    // that previously failed the whole file.
    private static readonly string[] DateFormats =
    {
        "yyyy-MM-dd", "yyyy/MM/dd", "dd/MM/yyyy", "MM/dd/yyyy", "dd.MM.yyyy",
        "d/M/yyyy", "M/d/yyyy", "dd-MM-yyyy", "yyyyMMdd", "dd MMM yyyy", "MMM d, yyyy",
        "dd/MM/yy", "MM/dd/yy", "d/M/yy", "M/d/yy", "dd.MM.yy", "dd-MM-yy",
    };

    [GeneratedRegex(@"^[A-Za-z]{3}$", RegexOptions.CultureInvariant)]
    private static partial Regex CurrencyCode();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRun();

    public CsvLayout Detect(string content)
    {
        var lines = NonEmptyLines(content);
        if (lines.Count == 0)
        {
            throw new StatementParseException("The CSV file is empty.");
        }

        var delimiter = DetectDelimiter(lines);
        var rows = lines.Select(l => SplitLine(l, delimiter)).ToList();

        // A header is a first row that carries no date of its own while later rows do.
        var hasHeader = rows.Count > 1
            && !RowHasDate(rows[0])
            && rows.Skip(1).Take(10).Any(RowHasDate);

        var dataRows = (hasHeader ? rows.Skip(1) : rows).Take(30).ToList();
        var columnCount = rows.Max(r => r.Count);
        var headers = hasHeader ? rows[0] : new List<string>();
        var columns = Enumerable.Range(0, columnCount)
            .Select(i => hasHeader && i < headers.Count && headers[i].Trim().Length > 0
                ? headers[i].Trim()
                : $"Column {i + 1}")
            .ToList();

        var mapping = GuessMapping(delimiter, hasHeader, columns, dataRows, columnCount);
        var sample = dataRows.Take(5).Select(r => (IReadOnlyList<string>)r).ToList();
        return new CsvLayout(columns, sample, mapping);
    }

    public ParsedStatement Parse(string content, CsvMapping mapping)
    {
        var lines = NonEmptyLines(content);
        if (lines.Count == 0)
        {
            throw new StatementParseException("The CSV file is empty.");
        }

        var rows = lines.Select(l => SplitLine(l, mapping.Delimiter)).ToList();
        var dataRows = (mapping.HasHeader ? rows.Skip(1) : rows).ToList();

        // Lock ONE date format for the whole file. Trying formats per row would read an
        // ambiguous "03/04/2026" as dd/MM on some rows and MM/dd on others in the same file —
        // inconsistent dates AND unstable idempotency references.
        var dateFormat = mapping.DateFormat ?? ResolveDateFormat(dataRows, mapping.DateColumn);

        var entries = new List<ParsedStatementEntry>();
        var references = new SignatureReferences("csv:");

        foreach (var row in dataRows)
        {
            if (!TryCell(row, mapping.DateColumn, out var dateCell) ||
                !TryParseDate(dateCell, dateFormat, out var date))
            {
                continue; // header remnant, blank, or a totals footer — not a transaction
            }

            if (!TryCell(row, mapping.AmountColumn, out var amountCell) ||
                !TryParseSignedAmount(amountCell, mapping.DecimalStyle, out var signed) ||
                signed == 0m)
            {
                continue;
            }

            TryCell(row, mapping.DescriptionColumn, out var descCell);
            var description = Normalize(descCell);

            // Display payee: surface just the merchant when the cell is an HSBC-style packed
            // Details blob. The idempotency signature stays on the RAW cell text, so references
            // from earlier imports of the same file still match.
            var payee = HsbcCsvStatementParser.TryCleanDetails(description, out var cleaned)
                ? cleaned
                : description;

            var currency = ResolveCurrency(row, mapping);

            var signature = string.Create(CultureInfo.InvariantCulture,
                $"{date:yyyy-MM-dd}|{signed:0.####}|{description.ToUpperInvariant()}");
            var (reference, legacy) = references.Next(signature);

            entries.Add(new ParsedStatementEntry(
                Amount: Math.Abs(signed),
                Currency: currency,
                IsCredit: signed > 0m,
                BookingDate: date,
                Payee: payee,
                Reference: reference)
            {
                LegacyReference = legacy,
            });
        }

        if (entries.Count == 0)
        {
            throw new StatementParseException(
                "No transactions were found — check that the date and amount columns are mapped correctly.");
        }

        // Echo the format that was actually applied, so the UI can show it and pin it for
        // re-scans/re-imports — auto-detection is file-relative and must not stay invisible.
        return new ParsedStatement(Entries: entries, ResolvedDateFormat: dateFormat);
    }

    // --- Detection helpers ---------------------------------------------------

    private static CsvMapping GuessMapping(
        char delimiter, bool hasHeader, List<string> columns, List<List<string>> dataRows, int columnCount)
    {
        double DateScore(int col) => Fraction(dataRows, col, c => TryParseDate(c, null, out _));
        double AmountScore(int col) => Fraction(dataRows, col, c => TryParseSignedAmount(c, CsvDecimalStyle.Auto, out _));
        double CurrencyScore(int col) => Fraction(dataRows, col, c => CurrencyCode().IsMatch(c.Trim()));
        double TextLen(int col) => dataRows.Count == 0 ? 0
            : dataRows.Average(r => col < r.Count ? r[col].Trim().Length : 0);

        var cols = Enumerable.Range(0, columnCount).ToList();

        // Header-name hints take priority; otherwise fall back to content scoring.
        int? ByHeader(params string[] needles) => !hasHeader ? null : columns
            .Select((name, i) => (name: name.ToLowerInvariant(), i))
            .Where(x => needles.Any(n => x.name.Contains(n)))
            .Select(x => (int?)x.i)
            .FirstOrDefault();

        var dateColumn = ByHeader("date", "posted", "booking")
            ?? cols.OrderByDescending(DateScore).First();
        var amountColumn = ByHeader("amount", "value")
            ?? cols.Where(c => c != dateColumn).OrderByDescending(AmountScore).FirstOrDefault(dateColumn == 0 ? 1 : 0);

        int? currencyColumn = ByHeader("currency", "ccy");
        if (currencyColumn is null)
        {
            var best = cols.Where(c => c != dateColumn && c != amountColumn)
                .Select(c => (c, s: CurrencyScore(c)))
                .OrderByDescending(x => x.s)
                .FirstOrDefault();
            currencyColumn = best.s >= 0.8 ? best.c : null;
        }

        var descriptionColumn = ByHeader("description", "payee", "memo", "details", "narrative", "reference", "name")
            ?? cols.Where(c => c != dateColumn && c != amountColumn && c != currencyColumn)
                .OrderByDescending(TextLen)
                .FirstOrDefault(dateColumn);

        return new CsvMapping(
            Delimiter: delimiter,
            HasHeader: hasHeader,
            DateColumn: dateColumn,
            AmountColumn: amountColumn,
            DescriptionColumn: descriptionColumn,
            CurrencyColumn: currencyColumn,
            DateFormat: null,
            DecimalStyle: CsvDecimalStyle.Auto,
            DefaultCurrency: null);
    }

    private static double Fraction(List<List<string>> rows, int col, Func<string, bool> predicate)
    {
        if (rows.Count == 0) return 0;
        var hits = rows.Count(r => col < r.Count && predicate(r[col]));
        return (double)hits / rows.Count;
    }

    private static bool RowHasDate(List<string> row) => row.Any(c => TryParseDate(c, null, out _));

    private static char DetectDelimiter(List<string> lines)
    {
        var sample = lines.Take(5).ToList();
        return CandidateDelimiters
            .OrderByDescending(d => sample.Sum(l => l.Count(ch => ch == d)))
            .First();
    }

    private static string ResolveCurrency(List<string> row, CsvMapping mapping)
    {
        if (mapping.CurrencyColumn is int cc && TryCell(row, cc, out var raw))
        {
            var code = raw.Trim().ToUpperInvariant();
            if (CurrencyCode().IsMatch(code)) return code;
        }
        return string.IsNullOrWhiteSpace(mapping.DefaultCurrency) ? "EUR" : mapping.DefaultCurrency.Trim().ToUpperInvariant();
    }

    /// <summary>
    /// Pick the single date format that parses the most rows of the file (ties resolved by the
    /// <see cref="DateFormats"/> preference order — ISO first, dd/MM before MM/dd). Null when no
    /// row parses under any format, in which case the row loop skips everything and the caller's
    /// "no transactions found" error explains it.
    /// </summary>
    private static string? ResolveDateFormat(List<List<string>> dataRows, int dateColumn)
    {
        var cells = dataRows
            .Select(r => dateColumn >= 0 && dateColumn < r.Count ? r[dateColumn].Trim() : string.Empty)
            .Where(c => c.Length > 0)
            .ToList();
        if (cells.Count == 0)
        {
            return null;
        }

        string? best = null;
        var bestHits = 0;
        foreach (var format in DateFormats)
        {
            var hits = cells.Count(c =>
                DateOnly.TryParseExact(c, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out _));
            if (hits > bestHits)
            {
                best = format;
                bestHits = hits;
            }
        }
        return best;
    }

    // --- Parsing primitives --------------------------------------------------

    private static List<string> NonEmptyLines(string content) =>
        (content ?? string.Empty)
            // A UTF-8 BOM that survived decoding would corrupt the first cell (and its reference).
            .TrimStart('\uFEFF')
            // Split on BOTH \n and \r: handles CRLF (the empties are filtered), LF, and the rare
            // bare-CR (classic Mac) export that would otherwise collapse into one giant line.
            .Split('\n', '\r')
            .Where(l => l.Trim().Length > 0)
            .ToList();

    private static bool TryCell(List<string> row, int index, out string value)
    {
        if (index >= 0 && index < row.Count)
        {
            value = row[index];
            return true;
        }
        value = string.Empty;
        return false;
    }

    private static bool TryParseDate(string value, string? format, out DateOnly date)
    {
        var text = value.Trim();
        if (text.Length == 0)
        {
            date = default;
            return false;
        }

        if (!string.IsNullOrWhiteSpace(format))
        {
            return DateOnly.TryParseExact(text, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out date);
        }

        foreach (var f in DateFormats)
        {
            if (DateOnly.TryParseExact(text, f, CultureInfo.InvariantCulture, DateTimeStyles.None, out date))
            {
                return true;
            }
        }

        date = default;
        return false;
    }

    private static bool TryParseSignedAmount(string raw, CsvDecimalStyle style, out decimal amount)
    {
        amount = 0m;
        var s = raw.Trim();
        if (s.Length == 0) return false;

        // Accounting-style negatives: "(35.00)" means -35.00.
        var parenNegative = s.StartsWith('(') && s.EndsWith(')');
        if (parenNegative) s = s[1..^1];

        // Keep only digits, separators and a sign — drop currency symbols, spaces, letters.
        var cleaned = new StringBuilder(s.Length);
        foreach (var c in s)
        {
            if (char.IsDigit(c) || c is '.' or ',' or '-' or '+') cleaned.Append(c);
        }

        var t = cleaned.ToString();
        // Sign may lead ("-35.00") or trail ("35.00-", the SAP/DATEV convention some EU banks use).
        var signNegative = t.StartsWith('-');
        t = t.TrimStart('+', '-');
        if (t.EndsWith('-'))
        {
            signNegative = true;
            t = t.TrimEnd('-');
        }
        else
        {
            t = t.TrimEnd('+');
        }
        if (t.Length == 0 || t.IndexOfAny(new[] { '+', '-' }) >= 0) return false; // a stray inner sign is not a number

        var normalized = style switch
        {
            CsvDecimalStyle.Dot => t.Replace(",", string.Empty),
            CsvDecimalStyle.Comma => t.Replace(".", string.Empty).Replace(',', '.'),
            _ => AutoNormalize(t),
        };

        if (!decimal.TryParse(normalized, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture, out var value))
        {
            return false;
        }

        amount = parenNegative || signNegative ? -value : value;
        return true;
    }

    /// <summary>Resolve '.'/',' to a decimal point when the style is auto (right-most separator wins).</summary>
    private static string AutoNormalize(string t)
    {
        var lastComma = t.LastIndexOf(',');
        var lastDot = t.LastIndexOf('.');

        if (lastComma >= 0 && lastDot >= 0)
        {
            var decimalIsComma = lastComma > lastDot;
            var grouping = decimalIsComma ? "." : ",";
            var stripped = t.Replace(grouping, string.Empty);
            return decimalIsComma ? stripped.Replace(',', '.') : stripped;
        }

        // A single separator is a decimal point only when it looks like one (1–2 trailing digits);
        // otherwise it's grouping ("1.234" -> 1234).
        if (lastComma >= 0)
        {
            return t.Count(c => c == ',') == 1 && t.Length - lastComma - 1 is >= 1 and <= 2
                ? t.Replace(',', '.')
                : t.Replace(",", string.Empty);
        }

        if (lastDot >= 0)
        {
            return t.Count(c => c == '.') == 1 && t.Length - lastDot - 1 is >= 1 and <= 2
                ? t
                : t.Replace(".", string.Empty);
        }

        return t;
    }

    private static string Normalize(string value) => WhitespaceRun().Replace(value.Trim(), " ");

    /// <summary>
    /// Minimal RFC-4180 splitter parameterised by delimiter: unquoted delimiters split fields, a
    /// quoted field may contain the delimiter, and "" is an escaped quote. One record per line.
    /// </summary>
    private static List<string> SplitLine(string line, char delimiter)
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
                        sb.Append('"');
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
            else if (c == delimiter)
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
