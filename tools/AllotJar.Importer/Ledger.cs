using System.Text;
using System.Text.RegularExpressions;
using ClosedXML.Excel;
using AllotJar.Domain.Enums;

namespace AllotJar.Importer;

/// <summary>One parsed ledger entry: which sheet-month + account it belongs to, and its signed movement.</summary>
internal sealed record TransactionRow(
    int Month, string Account, DateOnly Date, string Payee, decimal Amount, TransactionType Type, string? Code);

/// <summary>
/// All parsed ledger movements plus the spreadsheet's own per-month closing balances
/// (row 128 TOTAL per account) used as the reconciliation oracle, and the Visa balance owed.
/// </summary>
internal sealed record LedgerData(
    IReadOnlyList<TransactionRow> Rows,
    IReadOnlyDictionary<(int Month, string Account), decimal> MonthlyClose,
    decimal VisaOwed);

/// <summary>
/// Reads the 12 "Bank Account - &lt;month&gt;" ledgers (5 side-by-side account blocks each)
/// and the "Visa" credit-card sheet into <see cref="TransactionRow"/>s. Each block's Debit
/// column is money out (Expense), the Credit column money in (Income); the opening "Balance
/// B/d" row and the TOTAL row are skipped. The Savings-Joint block's code column (H) is
/// captured so living-cost spends can be attributed to their budget line.
/// </summary>
internal static class Ledger
{
    // month number → sheet-name suffix (note "June"/"August"/"Sep", not Jun/Aug/Sept).
    private static readonly string[] MonthSheet =
    {
        "Jan", "Feb", "Mar", "Apr", "May", "June",
        "July", "August", "Sep", "Oct", "Nov", "Dec",
    };

    public const string VisaAccount = "Visa";

    // account name, date col, details col, code col (null = none), debit col, credit col, close col
    private sealed record Block(string Account, int Date, int Details, int? Code, int Debit, int Credit, int Close);

    private static readonly Block[] Blocks =
    {
        new("Current Joint Account",  1,  2,  null,  3,  4,  3),
        new("Savings Joint Account",  6,  7,  8,     9, 10,  9),
        new("Liza - Savings Account", 13, 14, null, 16, 17, 16),
        new("Chris - Savings Account",19, 20, null, 22, 23, 22),
        new("Cash at Home",           26, 27, null, 29, 30, 29),
    };

    public static LedgerData Read(string file)
    {
        using var wb = Workbook.Open(file);
        var rows = new List<TransactionRow>();
        var closes = new Dictionary<(int, string), decimal>();

        for (int month = 1; month <= 12; month++)
        {
            var sheetName = $"Bank Account - {MonthSheet[month - 1]}";
            if (!wb.TryGetWorksheet(sheetName, out var ws)) continue;

            var totalRow = FindTotalRow(ws);
            foreach (var block in Blocks)
            {
                // The block's closing balance (oracle) at the TOTAL row.
                var close = ws.Cell(totalRow, block.Close).CachedValue;
                if (close.IsNumber) closes[(month, block.Account)] = (decimal)close.GetNumber();

                for (int r = 8; r < totalRow; r++)
                {
                    var debit = NumberAt(ws, r, block.Debit);
                    var credit = NumberAt(ws, r, block.Credit);

                    // Net movement = money in (credit) − money out (debit). Handles the
                    // sheet's negative-debit refunds (e.g. a "-15" in the Debit column is a
                    // €15 credit back), which a naive debit-vs-credit read would drop.
                    var net = credit - debit;
                    if (net == 0m) continue;

                    var details = TextAt(ws, r, block.Details);
                    if (details.Contains("Balance B/d", StringComparison.OrdinalIgnoreCase)) continue;

                    var type = net > 0m ? TransactionType.Income : TransactionType.Expense;
                    var amount = Math.Abs(net);
                    var date = DateAt(ws, r, block.Date) ?? new DateOnly(2026, month, 15);
                    var code = block.Code is { } cc ? TextAt(ws, r, cc).Trim().ToUpperInvariant() : null;

                    rows.Add(new TransactionRow(month, block.Account, date, CleanPayee(details), amount, type,
                        string.IsNullOrWhiteSpace(code) ? null : code));
                }
            }
        }

        var visaOwed = ReadVisa(wb, rows);
        return new LedgerData(rows, closes, visaOwed);
    }

    // --- Visa ---------------------------------------------------------------
    // Ledger at rows 12..(total). Col A date, B details, C total charge (negative = a
    // payment/cashback). D/E are the Liz/Chris split — ignored (the app has no member tag).
    private static decimal ReadVisa(XLWorkbook wb, List<TransactionRow> rows)
    {
        if (!wb.TryGetWorksheet("Visa", out var ws)) return 0m;

        decimal owed = 0m;
        for (int r = 12; r <= 200; r++)
        {
            var amount = NumberAt(ws, r, 3); // col C
            var details = TextAt(ws, r, 2);  // col B
            if (amount == 0m && string.IsNullOrWhiteSpace(details))
            {
                // Stop at the first fully blank row past the data.
                if (NumberAt(ws, r + 1, 3) == 0m && string.IsNullOrWhiteSpace(TextAt(ws, r + 1, 2))) break;
                continue;
            }
            if (amount == 0m) continue;

            owed += amount;
            var date = DateAt(ws, r, 1) ?? new DateOnly(2026, 1, 15);
            // A charge (C>0) grows the card debt → Expense; a payment/cashback (C<0) → Income.
            var type = amount > 0m ? TransactionType.Expense : TransactionType.Income;
            rows.Add(new TransactionRow(date.Month, VisaAccount, date, CleanPayee(details), Math.Abs(amount), type, null));
        }
        return owed;
    }

    // --- helpers ------------------------------------------------------------
    private static int FindTotalRow(IXLWorksheet ws)
    {
        for (int r = 8; r <= 200; r++)
        {
            if (TextAt(ws, r, 1).Equals("TOTAL", StringComparison.OrdinalIgnoreCase)) return r;
            if (TextAt(ws, r, 13).Equals("TOTAL", StringComparison.OrdinalIgnoreCase)) return r;
        }
        return 128;
    }

    private static decimal NumberAt(IXLWorksheet ws, int row, int col)
    {
        var v = ws.Cell(row, col).CachedValue;
        return v.IsNumber ? Math.Round((decimal)v.GetNumber(), 4, MidpointRounding.AwayFromZero) : 0m;
    }

    private static string TextAt(IXLWorksheet ws, int row, int col)
    {
        var v = ws.Cell(row, col).CachedValue;
        return v.IsText ? v.GetText() : "";
    }

    private static DateOnly? DateAt(IXLWorksheet ws, int row, int col)
    {
        var v = ws.Cell(row, col).CachedValue;
        return v.IsDateTime ? DateOnly.FromDateTime(v.GetDateTime()) : null;
    }

    /// <summary>Strips card-mask mojibake and non-ASCII noise, collapses whitespace, caps length.</summary>
    private static string CleanPayee(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "(imported)";
        var sb = new StringBuilder(raw.Length);
        foreach (var c in raw) sb.Append(c is >= ' ' and < (char)127 ? c : ' ');
        var cleaned = Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
        if (cleaned.Length == 0) return "(imported)";
        return cleaned.Length > 180 ? cleaned[..180] : cleaned;
    }
}
