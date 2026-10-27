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

    [GeneratedRegex(@"[^\p{L}\p{N}]+", RegexOptions.CultureInvariant)]
    private static partial Regex NonWord();

    public CsvLayout Detect(string content)
    {
        var lines = NonEmptyLines(content);
        if (lines.Count == 0)
        {
            throw new StatementParseException("The CSV file is empty.");
        }

        var delimiter = DetectDelimiter(lines);
        var rows = lines.Select(l => SplitLine(l, delimiter)).ToList();

        // Banks often print a few lines first (account name, period, opening balance). The table
        // starts at the first row with a date that is as wide as the transaction rows; the row just
        // above it is the header when it carries no date of its own.
        var dataStart = FindDataStart(rows);
        var hasHeader = dataStart > 0
            && !RowHasDate(rows[dataStart - 1])
            && rows[dataStart - 1].Count(c => c.Trim().Length > 0) >= 2;
        var skipRows = hasHeader ? dataStart - 1 : dataStart;

        var dataRows = rows.Skip(dataStart).Take(30).ToList();
        var columnCount = rows.Skip(skipRows).Max(r => r.Count);
        var headers = hasHeader ? rows[skipRows] : new List<string>();
        var columns = Enumerable.Range(0, columnCount)
            .Select(i => hasHeader && i < headers.Count && headers[i].Trim().Length > 0
                ? headers[i].Trim()
                : $"Column {i + 1}")
            .ToList();

        var mapping = GuessMapping(delimiter, hasHeader, columns, dataRows, columnCount) with { SkipRows = skipRows };
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

        var rows = lines.Select(l => SplitLine(l, mapping.Delimiter)).Skip(Math.Max(0, mapping.SkipRows)).ToList();
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

            if (!TryReadAmount(row, mapping, out var signed))
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
        var used = new HashSet<int>();

        // Header names first, by the names banks use for each column; content scoring otherwise.
        int? ByHeader(HeaderRole role) => !hasHeader ? null : BestHeader(columns, role, used);

        var dateColumn = ByHeader(Roles.Date)
            ?? ByHeader(Roles.ValueDate)
            ?? cols.OrderByDescending(DateScore).First();
        used.Add(dateColumn);

        // Separate money-out and money-in columns, by their headers or, without a header, two
        // number columns where each row fills exactly one.
        int? debitColumn = ByHeader(Roles.Debit);
        int? creditColumn = debitColumn is int d ? BestHeader(columns, Roles.Credit, [.. used, d]) : null;
        if (!hasHeader || debitColumn is null || creditColumn is null
            || !HoldsAmounts(dataRows, debitColumn.Value) || !HoldsAmounts(dataRows, creditColumn.Value))
        {
            debitColumn = creditColumn = null;
        }

        int? amountColumn = ByHeader(Roles.Amount);
        if (amountColumn is int a && debitColumn is null && AmountScore(a) < 0.5)
        {
            amountColumn = null; // "Amount" heads a column of something else; read the content
        }
        if (debitColumn is null && amountColumn is null)
        {
            var numeric = cols.Where(c => !used.Contains(c) && !IsBalance(columns, hasHeader, c)).ToList();
            // A pair first: a running balance beside them is a full number column too.
            var best = numeric.OrderByDescending(AmountScore).FirstOrDefault(-1);
            if (FindSplitPair(dataRows, numeric) is (int o, int i))
            {
                (debitColumn, creditColumn) = (o, i);
            }
            else if (best >= 0 && AmountScore(best) >= 0.8)
            {
                amountColumn = best;
            }
            else
            {
                amountColumn = best >= 0 ? best : (dateColumn == 0 ? 1 : 0);
            }
        }
        if (debitColumn is int dc && creditColumn is int cc2)
        {
            used.Add(dc);
            used.Add(cc2);
            amountColumn = null;
        }
        if (amountColumn is int ac)
        {
            used.Add(ac);
        }

        int? currencyColumn = ByHeader(Roles.Currency);
        if (currencyColumn is null)
        {
            var best = cols.Where(c => !used.Contains(c))
                .Select(c => (c, s: CurrencyScore(c)))
                .OrderByDescending(x => x.s)
                .FirstOrDefault();
            currencyColumn = best.s >= 0.8 ? best.c : null;
        }
        if (currencyColumn is int cur)
        {
            used.Add(cur);
        }

        // The description is the longest text that is neither a date nor a number.
        var descriptionColumn = ByHeader(Roles.Description)
            ?? cols.Where(c => !used.Contains(c) && DateScore(c) < 0.8 && AmountScore(c) < 0.8)
                .OrderByDescending(TextLen)
                .Cast<int?>()
                .FirstOrDefault()
            ?? cols.Where(c => !used.Contains(c)).OrderByDescending(TextLen).Cast<int?>().FirstOrDefault()
            ?? dateColumn;

        return new CsvMapping(
            Delimiter: delimiter,
            HasHeader: hasHeader,
            DateColumn: dateColumn,
            // Still a valid column when amounts are split, for a client that reads only this field.
            AmountColumn: amountColumn ?? debitColumn!.Value,
            DescriptionColumn: descriptionColumn,
            CurrencyColumn: currencyColumn,
            DateFormat: null,
            DecimalStyle: CsvDecimalStyle.Auto,
            DefaultCurrency: null,
            DebitColumn: debitColumn,
            CreditColumn: creditColumn);
    }

    /// <summary>
    /// The names banks give a column, best first, and the words that rule a header out (a
    /// "Balance" is never the amount, a "Value date" is not the booking date).
    /// </summary>
    private sealed record HeaderRole(string[] Names, string[] Excluded);

    private static class Roles
    {
        private static readonly string[] NotMoney = ["balance", "bilanċ", "bilanc", "date", "data", "card", "account", "rate", "reference", "ref", "number", "no"];

        public static readonly HeaderRole Date = new(
            ["transaction date", "booking date", "posting date", "posted date", "trans date", "txn date", "date", "data", "posted", "booked", "booking"],
            ["value", "balance", "bilanċ", "bilanc"]);

        public static readonly HeaderRole ValueDate = new(["value date"], []);

        public static readonly HeaderRole Amount = new(
            ["amount", "transaction amount", "amt", "sum", "value", "ammont"], NotMoney);

        public static readonly HeaderRole Debit = new(
            ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "paid out", "out", "dr",
             "payments", "payment", "outgoing", "outflow", "spent", "charges", "debitu"],
            [.. NotMoney, "credit", "kreditu"]);

        public static readonly HeaderRole Credit = new(
            ["credit", "credits", "credit amount", "deposit", "deposits", "money in", "paid in", "in", "cr",
             "receipts", "incoming", "inflow", "received", "lodgements", "lodgement", "kreditu"],
            [.. NotMoney, "debit", "debitu"]);

        public static readonly HeaderRole Currency = new(["currency", "ccy", "curr", "currency code"], ["amount"]);

        public static readonly HeaderRole Description = new(
            ["description", "transaction description", "details", "transaction details", "narrative", "narration",
             "payee", "merchant", "particulars", "beneficiary", "counterparty", "memo", "remarks", "deskrizzjoni",
             "dettalji", "name", "reference"],
            ["date", "balance", "amount"]);
    }

    /// <summary>
    /// The column whose header best names <paramref name="role"/>: an exact name beats a name
    /// within a longer header ("Amount (EUR)"), and an earlier name in the role's list beats a
    /// later one. Matching is on whole words, so "in" never matches "Description".
    /// </summary>
    private static int? BestHeader(List<string> columns, HeaderRole role, ICollection<int> taken)
    {
        int? best = null;
        var bestScore = 0;
        for (var i = 0; i < columns.Count; i++)
        {
            if (taken.Contains(i))
            {
                continue;
            }
            var header = $" {HeaderWords(columns[i])} ";
            if (header.Trim().Length == 0 || role.Excluded.Any(x => header.Contains($" {x} ", StringComparison.Ordinal)))
            {
                continue;
            }
            for (var n = 0; n < role.Names.Length; n++)
            {
                var name = role.Names[n];
                var score = header.Trim() == name ? 2000 - n
                    : header.Contains($" {name} ", StringComparison.Ordinal) ? 1000 - n
                    : 0;
                if (score > bestScore)
                {
                    (best, bestScore) = (i, score);
                }
            }
        }
        return best;
    }

    /// <summary>A header as lowercase words: "Debit (EUR)" reads "debit eur".</summary>
    private static string HeaderWords(string header) =>
        WhitespaceRun().Replace(NonWord().Replace(header.ToLowerInvariant(), " "), " ").Trim();

    private static bool IsBalance(List<string> columns, bool hasHeader, int col) =>
        hasHeader && col < columns.Count && $" {HeaderWords(columns[col])} ".Contains(" balance ", StringComparison.Ordinal);

    /// <summary>Every filled cell of the column is a number, and at least one is filled.</summary>
    private static bool HoldsAmounts(List<List<string>> rows, int col)
    {
        var filled = rows.Where(r => col < r.Count && r[col].Trim().Length > 0).ToList();
        return filled.Count > 0
            && filled.Count(r => TryParseSignedAmount(r[col], CsvDecimalStyle.Auto, out _)) >= filled.Count * 0.9;
    }

    /// <summary>
    /// Two number columns, side by side, where nearly every row fills exactly one: a money-out and
    /// a money-in column. Banks put money out first, so the left one is read as money out; the
    /// user can swap them on the column screen.
    /// </summary>
    private static (int Out, int In)? FindSplitPair(List<List<string>> rows, List<int> candidates)
    {
        if (rows.Count == 0)
        {
            return null;
        }
        static bool Filled(List<string> r, int c) =>
            c < r.Count && TryParseSignedAmount(r[c], CsvDecimalStyle.Auto, out var v) && v != 0m;
        foreach (var left in candidates)
        {
            var right = left + 1;
            if (!candidates.Contains(right) || !HoldsAmounts(rows, left) || !HoldsAmounts(rows, right))
            {
                continue;
            }
            var exactlyOne = rows.Count(r => Filled(r, left) ^ Filled(r, right));
            var both = rows.Any(r => Filled(r, left)) && rows.Any(r => Filled(r, right));
            if (both && exactlyOne >= rows.Count * 0.8)
            {
                return (left, right);
            }
        }
        return null;
    }

    /// <summary>
    /// The row's signed amount: from the one amount column, or money in less money out when the
    /// mapping splits them (a sign the bank printed in either column is ignored). False for a row
    /// with no amount, which is not a transaction.
    /// </summary>
    private static bool TryReadAmount(List<string> row, CsvMapping mapping, out decimal signed)
    {
        signed = 0m;
        if (!mapping.SplitAmounts)
        {
            return TryCell(row, mapping.AmountColumn, out var cell)
                && TryParseSignedAmount(cell, mapping.DecimalStyle, out signed)
                && signed != 0m;
        }
        var moneyOut = TryCell(row, mapping.DebitColumn!.Value, out var outCell)
            && TryParseSignedAmount(outCell, mapping.DecimalStyle, out var o) ? Math.Abs(o) : 0m;
        var moneyIn = TryCell(row, mapping.CreditColumn!.Value, out var inCell)
            && TryParseSignedAmount(inCell, mapping.DecimalStyle, out var i) ? Math.Abs(i) : 0m;
        signed = moneyIn - moneyOut;
        return signed != 0m;
    }

    /// <summary>
    /// The first row of the transaction table: the first row with a date that has as many cells as
    /// most dated rows do, so a "From,01/09/2026" line above the table is not taken for it.
    /// </summary>
    private static int FindDataStart(List<List<string>> rows)
    {
        var dated = rows.Take(200).Where(RowHasDate).ToList();
        if (dated.Count == 0)
        {
            return 0;
        }
        var width = dated.GroupBy(r => r.Count).OrderByDescending(g => g.Count()).ThenByDescending(g => g.Key).First().Key;
        var index = rows.FindIndex(r => r.Count >= width && RowHasDate(r));
        return index < 0 ? 0 : index;
    }

    private static double Fraction(List<List<string>> rows, int col, Func<string, bool> predicate)
    {
        if (rows.Count == 0) return 0;
        var hits = rows.Count(r => col < r.Count && predicate(r[col]));
        return (double)hits / rows.Count;
    }

    private static bool RowHasDate(List<string> row) => row.Any(c => TryParseDate(c, null, out _));

    /// <summary>
    /// The delimiter that splits the most lines into the same number of fields (more than one).
    /// Counting fields per line, not characters, keeps a preamble line or a decimal comma in a
    /// semicolon file from deciding it.
    /// </summary>
    private static char DetectDelimiter(List<string> lines)
    {
        var sample = lines.Take(40).ToList();
        return CandidateDelimiters
            .Select((d, order) =>
            {
                var widths = sample.Select(l => SplitLine(l, d).Count).Where(n => n > 1).ToList();
                var mode = widths.GroupBy(n => n).OrderByDescending(g => g.Count()).ThenByDescending(g => g.Key).FirstOrDefault();
                return (d, order, lines: mode?.Count() ?? 0, width: mode?.Key ?? 0);
            })
            .OrderByDescending(x => x.lines)
            .ThenByDescending(x => x.width)
            .ThenBy(x => x.order)
            .First().d;
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
