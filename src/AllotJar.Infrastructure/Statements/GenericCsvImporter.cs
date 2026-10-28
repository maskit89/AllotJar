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

    // An amount and nothing else: digits with separators, and around them an optional DR/CR,
    // bracket, sign, currency symbol or common currency code (a list, so "ATM 50" is not read as
    // 50 in a currency "ATM"), then an optional trailing sign, bracket and DR/CR or D/C.
    [GeneratedRegex(
        @"^(?:(?i:DR|CR)\s+)?\(?\s*[+\-\u2212]?\s*(?:[€$£¥]\s*|(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|ISK|AUD|CAD|NZD|JPY|CNY|TRY)\s?)?[+\-\u2212]?\s*\d[\d.,'\u00A0 ]*(?:\s?[€$£¥]|\s?(?:EUR|USD|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|ISK|AUD|CAD|NZD|JPY|CNY|TRY))?\s*[+\-\u2212]?\s*\)?\s*(?i:DR|CR|D|C)?\.?$",
        RegexOptions.CultureInvariant)]
    private static partial Regex StrictAmount();

    // A DR/CR marker before or after an amount ("DR 23.40", "23.40 DR", "50.00DR", "23.40 D").
    [GeneratedRegex(@"^(?<m>DR|CR)\s+|(?<=[\d\s)])(?<m>DR|CR|D|C)\.?$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)]
    private static partial Regex DirectionMarker();

    public CsvLayout Detect(string content)
    {
        var lines = NonEmptyLines(content);
        if (lines.Count == 0)
        {
            throw new StatementParseException("The CSV file is empty.");
        }

        var delimiter = DetectDelimiter(lines);
        var rows = lines.Select(l => SplitLine(l, delimiter)).ToList();

        // Banks often print a few lines first (account name, period, opening balance): find where
        // the table starts and whether a header row heads it.
        var (dataStart, hasHeader) = LocateTable(rows);
        var skipRows = hasHeader ? dataStart - 1 : dataStart;

        var table = rows.Skip(dataStart).ToList();
        var sample = table.Take(30).ToList();
        var columnCount = rows.Skip(skipRows).Max(r => r.Count);
        var headers = hasHeader ? rows[skipRows] : new List<string>();
        var columns = Enumerable.Range(0, columnCount)
            .Select(i => hasHeader && i < headers.Count && headers[i].Trim().Length > 0
                ? headers[i].Trim()
                : $"Column {i + 1}")
            .ToList();

        var mapping = GuessMapping(delimiter, hasHeader, columns, sample, table, columnCount) with { SkipRows = skipRows };
        var preview = sample.Take(5).Select(r => (IReadOnlyList<string>)r).ToList();
        return new CsvLayout(columns, preview, mapping);
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
        char delimiter, bool hasHeader, List<string> columns, List<List<string>> sample, List<List<string>> table, int columnCount)
    {
        double DateScore(int col) => Fraction(sample, col, c => TryParseDate(c, null, out _));
        double AmountScore(int col) => Fraction(sample, col, IsNumberCell);
        double CurrencyScore(int col) => Fraction(sample, col, c => CurrencyCode().IsMatch(c.Trim()));
        double TextLen(int col) => sample.Count == 0 ? 0
            : sample.Average(r => col < r.Count ? r[col].Trim().Length : 0);

        var cols = Enumerable.Range(0, columnCount).ToList();
        var used = new HashSet<int>();

        // Header names first, by the names banks use for each column; content scoring otherwise.
        int? ByHeader(HeaderRole role) => !hasHeader ? null : BestHeader(columns, role, used);

        var dateColumn = ByHeader(Roles.Date)
            ?? ByHeader(Roles.ValueDate)
            ?? cols.OrderByDescending(DateScore).First();
        used.Add(dateColumn);

        // A column named for money out or money in is never read as a signed amount: its numbers
        // carry no sign, so every row would become money in.
        var sideNamed = !hasHeader ? new HashSet<int>() : cols
            .Where(c => BestHeader(columns, Roles.Debit, []) == c || BestHeader(columns, Roles.Credit, []) == c)
            .ToHashSet();

        // Separate money-out and money-in columns named by their headers. Every filled cell must be
        // a number, read over the whole file: a card statement's Credit column may be empty.
        // Only the dated rows are transactions: a footer or a stray "PENDING" must not decide.
        var dated = table.Where(r => TryCell(r, dateColumn, out var c) && TryParseDate(c, null, out _)).ToList();
        int? debitColumn = ByHeader(Roles.Debit);
        int? creditColumn = debitColumn is int d ? BestHeader(columns, Roles.Credit, [.. used, d]) : null;
        if (debitColumn is not int dh || creditColumn is not int ch
            || !MostlyAmounts(dated, dh) || !MostlyAmounts(dated, ch)
            || (!AnyFilled(dated, dh) && !AnyFilled(dated, ch)))
        {
            debitColumn = creditColumn = null;
        }

        // A column of DR/CR (or Debit/Credit) markers gives the direction of an unsigned amount.
        // With a header it must be named for it, so a status column coded C/D is not taken.
        int? directionColumn = debitColumn is null
            ? cols.Where(c => !used.Contains(c) && (!hasHeader || HeaderScore(columns[c], Roles.Direction) > 0))
                .Cast<int?>()
                .FirstOrDefault(c => IsDirectionColumn(table, c!.Value))
            : null;
        if (directionColumn is int dir)
        {
            used.Add(dir);
        }

        int? amountColumn = debitColumn is null ? ByHeader(Roles.Amount) : null;
        if (amountColumn is int a && AmountScore(a) < 0.5)
        {
            amountColumn = null; // "Amount" heads a column of something else; read the content
        }
        if (debitColumn is null && amountColumn is null)
        {
            var numeric = cols
                .Where(c => !used.Contains(c) && !NamedNotMoney(columns, hasHeader, c) && !sideNamed.Contains(c))
                .ToList();
            var best = numeric.OrderByDescending(AmountScore).FirstOrDefault(-1);
            // A pair first (without a direction column): a running balance beside it is a full
            // number column too.
            if (directionColumn is null && FindSplitPair(table, numeric, cols.Where(c => !used.Contains(c)).ToList()) is (int o, int i))
            {
                (debitColumn, creditColumn) = (o, i);
            }
            else if (best >= 0 && AmountScore(best) >= 0.8)
            {
                amountColumn = best;
            }
            else
            {
                amountColumn = best >= 0 ? best : cols.FirstOrDefault(c => !used.Contains(c), dateColumn == 0 ? 1 : 0);
            }
        }
        if (debitColumn is int dc && creditColumn is int cc2)
        {
            used.Add(dc);
            used.Add(cc2);
            amountColumn = null;
            directionColumn = null;
        }
        if (amountColumn is int ac)
        {
            used.Add(ac);
        }

        int? currencyColumn = ByHeader(Roles.Currency);
        if (currencyColumn is null)
        {
            var best = cols.Where(c => !used.Contains(c)
                    && !(hasHeader && $" {HeaderWords(columns[c])} ".Contains(" original ", StringComparison.Ordinal)))
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
            CreditColumn: creditColumn,
            DirectionColumn: directionColumn);
    }

    /// <summary>
    /// The names banks give a column, best first, and the words that rule a header out (a
    /// "Balance" is never the amount, a "Value date" is not the booking date).
    /// </summary>
    private sealed record HeaderRole(string[] Names, string[] Excluded);

    private static class Roles
    {
        public static readonly string[] NotMoney = ["balance", "bilanċ", "bilanc", "date", "data", "card", "account", "rate", "reference", "ref", "number", "no"];

        public static readonly HeaderRole Date = new(
            ["transaction date", "booking date", "posting date", "posted date", "trans date", "txn date", "date", "data", "posted", "booked", "booking"],
            ["value", "balance", "bilanċ", "bilanc"]);

        public static readonly HeaderRole ValueDate = new(["value date"], []);

        // The amount in the account's own currency first, before an "Original Amount".
        public static readonly HeaderRole Amount = new(
            ["amount account currency", "amount in account currency", "account currency amount", "amount",
             "transaction amount", "amt", "sum", "value", "ammont"],
            [.. NotMoney.Where(x => x != "account")]);

        public static readonly HeaderRole Debit = new(
            ["debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "paid out", "out", "dr",
             "payments", "payment", "outgoing", "outflow", "spent", "charges", "debitu"],
            [.. NotMoney, "credit", "kreditu", "cr"]);

        public static readonly HeaderRole Credit = new(
            ["credit", "credits", "credit amount", "deposit", "deposits", "money in", "paid in", "in", "cr",
             "receipts", "incoming", "inflow", "received", "lodgements", "lodgement", "kreditu"],
            [.. NotMoney, "debit", "debitu", "dr"]);

        public static readonly HeaderRole Direction = new(
            ["dr cr", "cr dr", "debit credit", "credit debit", "d c", "c d", "direction", "sign", "indicator",
             "transaction type", "type", "dc"],
            []);

        // An "Original Currency" goes with the original amount, not the one imported.
        public static readonly HeaderRole Currency = new(["currency", "ccy", "curr", "currency code"], ["amount", "original"]);

        public static readonly HeaderRole Description = new(
            ["description", "transaction description", "details", "transaction details", "payment details", "narrative",
             "narration", "payee", "merchant", "particulars", "beneficiary", "counterparty", "memo", "remarks",
             "deskrizzjoni", "dettalji", "name", "reference"],
            ["date", "balance", "amount", "account"]);
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
            var score = HeaderScore(columns[i], role);
            if (score > bestScore)
            {
                (best, bestScore) = (i, score);
            }
        }
        return best;
    }

    private static int HeaderScore(string column, HeaderRole role)
    {
        var header = $" {HeaderWords(column)} ";
        if (header.Trim().Length == 0 || role.Excluded.Any(x => header.Contains($" {x} ", StringComparison.Ordinal)))
        {
            return 0;
        }
        var best = 0;
        for (var n = 0; n < role.Names.Length; n++)
        {
            var name = role.Names[n];
            var score = header.Trim() == name ? 2000 - n
                : header.Contains($" {name} ", StringComparison.Ordinal) ? 1000 - n
                : 0;
            best = Math.Max(best, score);
        }
        return best;
    }

    /// <summary>A header as lowercase words: "Debit (EUR)" reads "debit eur".</summary>
    private static string HeaderWords(string header) =>
        WhitespaceRun().Replace(NonWord().Replace(header.ToLowerInvariant(), " "), " ").Trim();

    /// <summary>A column whose header says it is not money moving (a balance, a reference, a number).</summary>
    private static bool NamedNotMoney(List<string> columns, bool hasHeader, int col) =>
        hasHeader && col < columns.Count
        && Roles.NotMoney.Any(x => $" {HeaderWords(columns[col])} ".Contains($" {x} ", StringComparison.Ordinal));

    /// <summary>
    /// Nearly every filled cell of the column is an amount (an empty column qualifies): one
    /// "PENDING" in a Debit column, or one in twenty, must not drop the pair its header names.
    /// </summary>
    private static bool MostlyAmounts(List<List<string>> rows, int col)
    {
        var filled = rows.Where(r => col < r.Count && !IsBlank(r[col])).ToList();
        var numbers = filled.Count(r => IsNumberCell(r[col]));
        var others = filled.Count - numbers;
        return filled.Count == 0 || (others <= Math.Max(1, filled.Count * 0.05) && numbers > others);
    }

    /// <summary>
    /// Whether a cell reads as an amount for detection: digits with separators, and nothing else
    /// but a sign, brackets, a currency symbol or code and a DR/CR marker. Stricter than
    /// <see cref="TryParseSignedAmount"/>, which reads a mapped column and drops any other text,
    /// so "POS 4921 LIDL" is never taken for 4921. A date is not an amount.
    /// </summary>
    private static bool IsNumberCell(string cell) =>
        StrictAmount().IsMatch(cell.Trim()) && !TryParseDate(cell, null, out _);

    /// <summary>An empty cell, or a dash or "n/a" a bank prints for nothing.</summary>
    private static bool IsBlank(string cell) =>
        cell.Trim() is "" or "-" or "–" or "—" or "−" or "n/a" or "N/A" or "na" or "NA";

    private static bool AnyFilled(List<List<string>> rows, int col) =>
        rows.Any(r => col < r.Count && !IsBlank(r[col]));

    /// <summary>Every filled cell of the column is an amount (an empty column qualifies).</summary>
    private static bool OnlyAmounts(List<List<string>> rows, int col) =>
        rows.All(r => col >= r.Count || IsBlank(r[col]) || IsNumberCell(r[col]));

    private static bool HasNegative(List<List<string>> rows, int col) =>
        rows.Any(r => col < r.Count && !IsBlank(r[col])
            && TryParseSignedAmount(r[col], CsvDecimalStyle.Auto, out var v) && v < 0m);

    private static readonly HashSet<string> DirectionWords = new(StringComparer.OrdinalIgnoreCase)
    {
        "dr", "cr", "d", "c", "db", "dt", "ct", "debit", "credit", "debitu", "kreditu",
    };

    /// <summary>A column that holds only DR/CR (or Debit/Credit) markers, filled on most rows.</summary>
    private static bool IsDirectionColumn(List<List<string>> rows, int col)
    {
        var filled = rows.Where(r => col < r.Count && !IsBlank(r[col])).Select(r => r[col].Trim().TrimEnd('.')).ToList();
        return filled.Count > 0
            && filled.Count >= rows.Count * 0.8
            && filled.All(DirectionWords.Contains)
            && filled.Select(DirectionSign).Distinct().Count() > 1;
    }

    /// <summary>-1 for a money-out marker, +1 for money in, 0 for anything else.</summary>
    private static int DirectionSign(string cell) => cell.Trim().TrimEnd('.').ToLowerInvariant() switch
    {
        "dr" or "d" or "db" or "dt" or "debit" or "debitu" => -1,
        "cr" or "c" or "ct" or "credit" or "kreditu" => 1,
        _ => 0,
    };

    /// <summary>
    /// Two number columns, side by side, where nearly every row fills exactly one: a money-out and
    /// a money-in column. Neither may hold a negative number (that is a signed amount) and each
    /// must be filled on a real share of rows (a fee or cheque-number column is not). Banks put
    /// money out first; a running balance in <paramref name="others"/> decides when it disagrees.
    /// </summary>
    private static (int Out, int In)? FindSplitPair(List<List<string>> rows, List<int> candidates, List<int> others)
    {
        if (rows.Count == 0)
        {
            return null;
        }
        static bool Filled(List<string> r, int c) =>
            c < r.Count && !IsBlank(r[c]) && TryParseSignedAmount(r[c], CsvDecimalStyle.Auto, out var v) && v != 0m;
        var share = Math.Max(1, (int)Math.Ceiling(rows.Count * 0.1));
        foreach (var left in candidates)
        {
            var right = left + 1;
            if (!candidates.Contains(right)
                || !OnlyAmounts(rows, left) || !OnlyAmounts(rows, right)
                || HasNegative(rows, left) || HasNegative(rows, right))
            {
                continue;
            }
            if (rows.Count(r => Filled(r, left)) < share || rows.Count(r => Filled(r, right)) < share)
            {
                continue;
            }
            var exactlyOne = rows.Count(r => Filled(r, left) ^ Filled(r, right));
            if (exactlyOne < rows.Count * 0.8)
            {
                continue;
            }
            return BalanceSaysMoneyInIsLeft(rows, left, right, others.Where(c => c != left && c != right))
                ? (right, left)
                : (left, right);
        }
        return null;
    }

    /// <summary>
    /// Whether a running-balance column says "left is money out" is the wrong way round. Each
    /// reading of the file (oldest or newest row first, left as money out or as money in) is
    /// counted by how many steps the balance moves by exactly that row's money in less money out;
    /// only a reading that explains most steps decides.
    /// </summary>
    private static bool BalanceSaysMoneyInIsLeft(List<List<string>> rows, int left, int right, IEnumerable<int> others)
    {
        decimal Value(List<string> r, int c) =>
            c < r.Count && TryParseSignedAmount(r[c], CsvDecimalStyle.Auto, out var v) ? Math.Abs(v) : 0m;
        foreach (var bal in others)
        {
            if (!OnlyAmounts(rows, bal) || rows.Count(r => bal < r.Count && !IsBlank(r[bal])) < rows.Count * 0.9)
            {
                continue;
            }
            int steps = 0, oldestAsIs = 0, oldestSwapped = 0, newestAsIs = 0, newestSwapped = 0;
            for (var i = 1; i < rows.Count; i++)
            {
                if (bal >= rows[i].Count || bal >= rows[i - 1].Count
                    || !TryParseSignedAmount(rows[i][bal], CsvDecimalStyle.Auto, out var now)
                    || !TryParseSignedAmount(rows[i - 1][bal], CsvDecimalStyle.Auto, out var before))
                {
                    continue;
                }
                steps++;
                // Oldest first, the step belongs to this row; newest first, to the row above.
                var netHere = Value(rows[i], right) - Value(rows[i], left);
                var netAbove = Value(rows[i - 1], right) - Value(rows[i - 1], left);
                if (now - before == netHere) oldestAsIs++;
                if (now - before == -netHere) oldestSwapped++;
                if (before - now == netAbove) newestAsIs++;
                if (before - now == -netAbove) newestSwapped++;
            }
            var best = new[] { oldestAsIs, oldestSwapped, newestAsIs, newestSwapped }.Max();
            if (steps > 0 && best >= steps * 0.6)
            {
                return best != oldestAsIs && best != newestAsIs;
            }
        }
        return false;
    }

    /// <summary>
    /// The row's signed amount: from the one amount column (its sign set by the direction column
    /// when there is one), or money in less money out when the mapping splits them (a sign the
    /// bank printed in either column is ignored). False for a row with no amount.
    /// </summary>
    private static bool TryReadAmount(List<string> row, CsvMapping mapping, out decimal signed)
    {
        signed = 0m;
        if (!mapping.SplitAmounts)
        {
            if (!TryCell(row, mapping.AmountColumn, out var cell)
                || !TryParseSignedAmount(cell, mapping.DecimalStyle, out signed)
                || signed == 0m)
            {
                return false;
            }
            if (mapping.DirectionColumn is int dc && TryCell(row, dc, out var marker) && DirectionSign(marker) is var sign && sign != 0)
            {
                signed = sign * Math.Abs(signed);
            }
            return true;
        }
        var moneyOut = TryCell(row, mapping.DebitColumn!.Value, out var outCell)
            && TryParseSignedAmount(outCell, mapping.DecimalStyle, out var o) ? Math.Abs(o) : 0m;
        var moneyIn = TryCell(row, mapping.CreditColumn!.Value, out var inCell)
            && TryParseSignedAmount(inCell, mapping.DecimalStyle, out var i) ? Math.Abs(i) : 0m;
        signed = moneyIn - moneyOut;
        return signed != 0m;
    }

    /// <summary>
    /// Where the transaction table starts, and whether a header row sits right above it. A row
    /// naming a date column and an amount, debit or credit column is the header. Without one, the
    /// table starts at the first row with a date in the column where most rows have theirs, so a
    /// "Period,01/09/2026,30/09/2026" line above the table is not taken for it, and a first row
    /// the bank printed without its trailing empty fields is not skipped.
    /// </summary>
    private static (int DataStart, bool HasHeader) LocateTable(List<List<string>> rows)
    {
        // A summary block above the table ("Statement Date,…,Total Amount" and its values) names
        // the same kinds of columns. Of the rows that do, the header is the one with the most rows
        // dated in the column it names as the date, counted down to the next such row (undated
        // rows such as "Balance brought forward" or a second description line are passed over);
        // on a tie the later one, nearer the data.
        var candidates = new List<(int Row, int DateColumn)>();
        for (var i = 0; i < Math.Min(rows.Count - 1, 50); i++)
        {
            var row = rows[i];
            if (RowHasDate(row)
                || !row.Any(c => HeaderScore(c, Roles.Amount) > 0 || HeaderScore(c, Roles.Debit) > 0 || HeaderScore(c, Roles.Credit) > 0))
            {
                continue;
            }
            if ((BestHeader(row, Roles.Date, []) ?? BestHeader(row, Roles.ValueDate, [])) is int named)
            {
                candidates.Add((i, named));
            }
        }
        // A header the bank repeats on every page heads one table: its pages' rows add up, and
        // the table starts under its first copy.
        static string Key(List<string> row) => string.Join("\u001f", row.Select(c => c.Trim().ToLowerInvariant()));
        var dated = new int[candidates.Count];
        for (var k = 0; k < candidates.Count; k++)
        {
            var (row, dc) = candidates[k];
            var end = k + 1 < candidates.Count ? candidates[k + 1].Row : rows.Count;
            for (var j = row + 1; j < end; j++)
            {
                if (TryCell(rows[j], dc, out var cell) && TryParseDate(cell, null, out _))
                {
                    dated[k]++;
                }
            }
        }
        var header = -1;
        var most = 0;
        for (var k = 0; k < candidates.Count; k++)
        {
            var key = Key(rows[candidates[k].Row]);
            if (Enumerable.Range(0, k).Any(e => Key(rows[candidates[e].Row]) == key))
            {
                continue; // a repeat, counted with its first copy
            }
            var total = Enumerable.Range(k, candidates.Count - k)
                .Where(e => Key(rows[candidates[e].Row]) == key)
                .Sum(e => dated[e]);
            if (total > 0 && total >= most)
            {
                (header, most) = (candidates[k].Row, total);
            }
        }
        if (header >= 0)
        {
            return (header + 1, true);
        }

        var dateColumns = rows.Take(200)
            .Select(r => r.FindIndex(c => TryParseDate(c, null, out _)))
            .Where(c => c >= 0)
            .ToList();
        if (dateColumns.Count == 0)
        {
            return (0, false);
        }
        var dateColumn = dateColumns.GroupBy(c => c).OrderByDescending(g => g.Count()).ThenBy(g => g.Key).First().Key;
        var start = rows.FindIndex(r => r.Count > dateColumn && r.FindIndex(c => TryParseDate(c, null, out _)) == dateColumn);
        start = Math.Max(0, start);
        var hasHeader = start > 0
            && !RowHasDate(rows[start - 1])
            && rows[start - 1].Count(c => c.Trim().Length > 0) >= 2;
        return (start, hasHeader);
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
        var s = raw.Trim().Replace('\u2212', '-'); // a typographic minus
        if (s.Length == 0) return false;

        // "23.40 DR" is money out and "2,100.00 CR" money in, whatever sign is printed.
        var marker = DirectionMarker().Match(s);
        var markerSign = marker.Success ? DirectionSign(marker.Groups["m"].Value) : 0;
        if (marker.Success)
        {
            s = s.Remove(marker.Index, marker.Length).Trim();
        }

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

        amount = markerSign != 0 ? markerSign * value
            : parenNegative || signNegative ? -value : value;
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
