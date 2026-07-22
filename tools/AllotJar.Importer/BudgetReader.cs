using ClosedXML.Excel;

namespace AllotJar.Importer;

/// <summary>
/// Parses the monthly-budget inputs that aren't reference data:
///   - "Living Costs" rows 4-15 → the 12 real living-cost envelopes (code, name, monthly
///     budget). Rows 16-21 are deliberately skipped — they are category sums of the
///     Yearly sinking-fund contributions, which the budget represents as fund lines.
///   - "Future Savings" → pocket money (€250 each) and the per-member personal-savings
///     surplus from the allocation waterfall (Alex F9 1200.50, Sam E9 800.25).
/// </summary>
internal static class BudgetReader
{
    public static BudgetSheetData Read(string file, IReadOnlyList<MemberSeed> members)
    {
        using var wb = Workbook.Open(file);
        var living = Sheet(wb, "Living Costs");
        var future = Sheet(wb, "Future Savings");

        var lines = new List<LivingCostLine>();
        for (int r = 4; r <= 15; r++)
        {
            var code = Str(living, $"A{r}");
            var name = Str(living, $"B{r}");
            if (string.IsNullOrWhiteSpace(name)) continue;
            lines.Add(new LivingCostLine(code, name, Num(living, $"C{r}")));
        }

        // Pocket money: Future Savings C8 = -(250 * 2). Personal-savings surplus per member:
        // E9 (Sam) / F9 (Alex), matched to the parsed member names by income (Alex higher).
        var pocket = Math.Abs(Num(future, "C8")) / 2m;
        var ordered = members.OrderByDescending(m => m.NetMonthlyIncome).ToList();
        var surplus = new Dictionary<string, decimal>(StringComparer.OrdinalIgnoreCase);
        if (ordered.Count > 0) surplus[ordered[0].Name] = Num(future, "F9"); // higher earner = Alex
        if (ordered.Count > 1) surplus[ordered[1].Name] = Num(future, "E9"); // Sam

        return new BudgetSheetData(lines, pocket, surplus);
    }

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
}
