using ClosedXML.Excel;

namespace ZeroBudget.Importer;

/// <summary>
/// Prints the parsed reference data and checks each summed figure against the
/// spreadsheet's own total cells (its built-in "check" oracles). Returns true when
/// every check is within tolerance — the green light to commit the reference data.
/// </summary>
internal static class ReconcileReport
{
    private const decimal Tolerance = 0.05m;

    public static bool Print(string file, ReferenceData data)
    {
        using var wb = Workbook.Open(file);
        decimal Oracle(string sheet, string cell) =>
            wb.TryGetWorksheet(sheet, out var ws) && ws.Cell(cell).CachedValue.IsNumber
                ? (decimal)ws.Cell(cell).CachedValue.GetNumber()
                : 0m;

        var checks = new List<Check>();

        // --- Accounts -------------------------------------------------------
        Console.WriteLine();
        Console.WriteLine("ACCOUNTS (opening 'Balance B/d' carried into 2026)");
        Console.WriteLine($"  {"Name",-26} {"Type",-9} {"Opening",14} {"Jan close (r128)",18}");
        foreach (var a in data.Accounts)
        {
            Console.WriteLine($"  {a.Name,-26} {a.Type,-9} {Money(a.Opening),14} {Money(a.JanClose),18}");
        }
        Console.WriteLine($"  {"",-26} {"",-9} {Money(data.Accounts.Sum(a => a.Opening)),14} {Money(data.Accounts.Sum(a => a.JanClose)),18}");
        Console.WriteLine("  (opening + January transactions should equal the Jan-close column — reconciled in the transaction phase.)");

        // --- Members --------------------------------------------------------
        Console.WriteLine();
        Console.WriteLine("HOUSEHOLD MEMBERS (net monthly income)");
        foreach (var m in data.Members)
        {
            Console.WriteLine($"  {m.Name,-12} net {Money(m.NetMonthlyIncome),12}   savings → {m.SavingsAccountName}");
        }
        var memberTotal = data.Members.Sum(m => m.NetMonthlyIncome);
        checks.Add(new Check("Members: Σ net monthly", memberTotal, Oracle("Future Savings", "C5")));

        // --- Yearly (proportional-pool) funds ------------------------------
        var yearly = data.Funds.Where(f => f.Accrual == Domain.Enums.AccrualMethod.ProportionalPool).ToList();
        PrintFundTable("YEARLY EXPENSES — discretionary sinking funds (proportional-pool)", yearly);
        checks.Add(new Check("Yearly: Σ target",  yearly.Sum(f => f.TargetAmount),        Oracle("Yearly Expenses", "B29")));
        checks.Add(new Check("Yearly: Σ monthly", yearly.Sum(f => f.MonthlyContribution), Oracle("Yearly Expenses", "F29")));
        checks.Add(new Check("Yearly: Σ opening", yearly.Sum(f => f.Opening),             Oracle("Yearly Expenses", "J29")));

        // --- Monthly (straight-line) commitment funds ----------------------
        var monthly = data.Funds.Where(f => f.Accrual == Domain.Enums.AccrualMethod.StraightLine).ToList();
        PrintFundTable("MONTHLY EXPENSES — commitment sinking funds (straight-line)", monthly);
        checks.Add(new Check("Monthly: Σ monthly", monthly.Sum(f => f.MonthlyContribution), Oracle("Monthly Expenses", "C22")));
        checks.Add(new Check("Monthly: Σ opening", monthly.Sum(f => f.Opening),             Oracle("Monthly Expenses", "H22")));

        // --- Reconciliation summary ----------------------------------------
        Console.WriteLine();
        Console.WriteLine("RECONCILIATION vs spreadsheet totals");
        Console.WriteLine($"  {"Check",-26} {"Parsed",14} {"Sheet",14} {"Δ",10}  Result");
        var allOk = true;
        foreach (var c in checks)
        {
            var delta = c.Parsed - c.Sheet;
            var ok = Math.Abs(delta) <= Tolerance;
            allOk &= ok;
            Console.WriteLine($"  {c.Label,-26} {Money(c.Parsed),14} {Money(c.Sheet),14} {Money(delta),10}  {(ok ? "OK" : "*** MISMATCH ***")}");
        }

        Console.WriteLine();
        Console.WriteLine($"Parsed {data.Accounts.Count} accounts, {data.Members.Count} members, "
            + $"{yearly.Count} yearly + {monthly.Count} monthly funds.");
        Console.WriteLine(allOk
            ? "RECONCILIATION PASSED — reference data ties out to the spreadsheet."
            : "RECONCILIATION FAILED — investigate the mismatches above before committing.");
        return allOk;
    }

    private static void PrintFundTable(string title, IReadOnlyList<FundSeed> funds)
    {
        Console.WriteLine();
        Console.WriteLine(title);
        Console.WriteLine($"  {"Name",-34} {"Target",12} {"Monthly",10} {"Opening",12}  Cover");
        foreach (var f in funds)
        {
            var cover = f.CoverStart is { } s && f.CoverEnd is { } e ? $"{s:yyyy-MM-dd} to {e:yyyy-MM-dd}" : "";
            Console.WriteLine($"  {Trunc(f.Name, 34),-34} {Money(f.TargetAmount),12} {Money(f.MonthlyContribution),10} {Money(f.Opening),12}  {cover}");
        }
        Console.WriteLine($"  {"TOTAL",-34} {Money(funds.Sum(f => f.TargetAmount)),12} {Money(funds.Sum(f => f.MonthlyContribution)),10} {Money(funds.Sum(f => f.Opening)),12}");
    }

    private static string Money(decimal d) => d.ToString("#,##0.00");
    private static string Trunc(string s, int n) => s.Length <= n ? s : s.Substring(0, n - 1) + "…";

    private sealed record Check(string Label, decimal Parsed, decimal Sheet);
}
