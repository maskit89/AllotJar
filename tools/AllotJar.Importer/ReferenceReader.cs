using ClosedXML.Excel;
using AllotJar.Domain.Enums;

namespace AllotJar.Importer;

/// <summary>
/// Parses the workbook's reference sheets into a <see cref="ReferenceData"/>:
///   - "Bank Account - Jan" → the five accounts and their opening (Balance B/d) balances;
///   - "Future Savings"     → the household members and their net monthly income;
///   - "Yearly Expenses"    → discretionary sinking funds (proportional-pool accrual);
///   - "Monthly Expenses"   → commitment sinking funds (straight-line accrual).
/// Cell positions mirror the decoded 2026 layout; values are read from the cached
/// formula results (the workbook is never recalculated).
/// </summary>
internal static class ReferenceReader
{
    public static ReferenceData Read(string file)
    {
        using var wb = Workbook.Open(file);
        return new ReferenceData(
            ReadAccounts(Sheet(wb, "Bank Account - Jan")),
            ReadMembers(Sheet(wb, "Future Savings")),
            ReadYearlyFunds(Sheet(wb, "Yearly Expenses"))
                .Concat(ReadMonthlyFunds(Sheet(wb, "Monthly Expenses")))
                .ToList());
    }

    // --- Accounts -----------------------------------------------------------
    // Five side-by-side blocks on the Jan sheet. Row 4 = name, row 7 = "Balance
    // B/d" with the opening in the block's Credit column, row 128 = TOTAL (the
    // post-January balance) in the block's Debit-less running column.
    private static IReadOnlyList<AccountSeed> ReadAccounts(IXLWorksheet ws) => new[]
    {
        Account(ws, "A4", AccountType.Current, opening: "D7",  janClose: "C128"),
        Account(ws, "F4", AccountType.Savings, opening: "J7",  janClose: "I128"),
        Account(ws, "M4", AccountType.Savings, opening: "Q7",  janClose: "P128"),
        Account(ws, "S4", AccountType.Savings, opening: "W7",  janClose: "V128"),
        Account(ws, "Z4", AccountType.Cash,    opening: "AD7", janClose: "AC128"),
    };

    private static AccountSeed Account(IXLWorksheet ws, string nameCell, AccountType type,
        string opening, string janClose) =>
        new(CleanName(Str(ws, nameCell)), type, Num(ws, opening), Num(ws, janClose));

    // --- Members ------------------------------------------------------------
    // Future Savings rows 3 (Chris) and 4 (Liza): col A name, col C net monthly.
    private static IReadOnlyList<MemberSeed> ReadMembers(IXLWorksheet ws)
    {
        var members = new List<MemberSeed>();
        for (int r = 3; r <= 4; r++)
        {
            var name = Str(ws, $"A{r}");
            if (string.IsNullOrWhiteSpace(name)) continue;
            members.Add(new MemberSeed(name, Num(ws, $"C{r}"), $"{name} - Savings Account"));
        }
        return members;
    }

    // --- Yearly Expenses (discretionary sinking funds) ----------------------
    // Rows 3-28: A name, B yearly target, C category, F monthly (= proportional
    // share of the €1400 pool), J opening balance carried into 2026.
    private static IEnumerable<FundSeed> ReadYearlyFunds(IXLWorksheet ws)
    {
        for (int r = 3; r <= 28; r++)
        {
            var name = Str(ws, $"A{r}");
            if (string.IsNullOrWhiteSpace(name) || name.StartsWith("Total", StringComparison.OrdinalIgnoreCase))
                continue;

            yield return new FundSeed(
                Name: name,
                Category: Str(ws, $"C{r}"),
                TargetAmount: Num(ws, $"B{r}"),
                MonthlyContribution: Num(ws, $"F{r}"),
                Opening: Num(ws, $"J{r}"),
                Accrual: AccrualMethod.ProportionalPool,
                CoverStart: null,
                CoverEnd: null);
        }
    }

    // --- Monthly Expenses (commitment sinking funds) ------------------------
    // Rows 5-19: A name, B yearly cost (blank for the loan/pension), C monthly,
    // E-F cover period, H opening balance. The straight-line target is B when
    // present, else the monthly figure annualised so target/12 reproduces C.
    private static IEnumerable<FundSeed> ReadMonthlyFunds(IXLWorksheet ws)
    {
        for (int r = 5; r <= 19; r++)
        {
            var name = Str(ws, $"A{r}");
            if (string.IsNullOrWhiteSpace(name)) continue;

            var yearly = Num(ws, $"B{r}");
            var monthly = Num(ws, $"C{r}");
            yield return new FundSeed(
                Name: name,
                Category: "Monthly Commitment",
                TargetAmount: yearly > 0m ? yearly : Math.Round(monthly * 12m, 4),
                MonthlyContribution: monthly,
                Opening: Num(ws, $"H{r}"),
                Accrual: AccrualMethod.StraightLine,
                CoverStart: DateOrNull(ws, $"E{r}"),
                CoverEnd: DateOrNull(ws, $"F{r}"));
        }
    }

    // --- Cell helpers -------------------------------------------------------
    private static IXLWorksheet Sheet(XLWorkbook wb, string name) =>
        wb.TryGetWorksheet(name, out var ws)
            ? ws
            : throw new InvalidOperationException($"Sheet '{name}' not found in workbook.");

    private static decimal Num(IXLWorksheet ws, string address)
    {
        var v = ws.Cell(address).CachedValue;
        return v.IsNumber ? Math.Round((decimal)v.GetNumber(), 4, MidpointRounding.AwayFromZero) : 0m;
    }

    private static string Str(IXLWorksheet ws, string address)
    {
        var v = ws.Cell(address).CachedValue;
        return v.IsText ? v.GetText().Trim() : "";
    }

    private static DateOnly? DateOrNull(IXLWorksheet ws, string address)
    {
        var v = ws.Cell(address).CachedValue;
        return v.IsDateTime ? DateOnly.FromDateTime(v.GetDateTime()) : null;
    }

    /// <summary>Tidies a sheet account header into a short account name.</summary>
    private static string CleanName(string raw) => raw
        .Replace("(USED FOR MONTHLY EXPENSES)", "", StringComparison.OrdinalIgnoreCase)
        .Trim();
}
