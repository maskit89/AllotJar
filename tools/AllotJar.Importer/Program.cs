using ClosedXML.Excel;

namespace AllotJar.Importer;

/// <summary>
/// One-off seeder that reads the household "Bank Account Summary 2026" workbook and
/// loads the real reference data (accounts, members, sinking funds) — and later the
/// year's transactions — into the AllotJar database via the Application layer.
///
/// Verbs:
///   dump &lt;sheet&gt; [startRow] [endRow]   Print non-empty cells of a sheet (exploration).
///   reconcile                            Parse the reference data and tie it out to the
///                                        spreadsheet totals (read-only; no database).
///
/// The workbook path defaults to the user's Downloads copy and can be overridden with
/// --file &lt;path&gt;.
/// </summary>
internal static class Program
{
    private const string DefaultWorkbook =
        @"C:\Users\Laptop\Downloads\Bank Account Summary 2026 - copy.xlsx";

    private const string DefaultEmail = "chrismuscat89@gmail.com";

    private static async Task<int> Main(string[] args)
    {
        try
        {
            var (positional, options) = ParseArgs(args);
            var file = options.GetValueOrDefault("file", DefaultWorkbook);
            var email = options.GetValueOrDefault("email", DefaultEmail);
            var conn = options.GetValueOrDefault("conn", ImporterHost.DefaultConnection);

            var verb = positional.Count > 0 ? positional[0].ToLowerInvariant() : "help";
            switch (verb)
            {
                case "dump":
                    return Dump(file, positional);
                case "reconcile":
                    return ReconcileReport.Print(file, ReferenceReader.Read(file)) ? 0 : 2;
                case "status":
                    return await DbCommands.Status(conn, email);
                case "import":
                {
                    var data = ReferenceReader.Read(file);
                    var ok = ReconcileReport.Print(file, data);
                    if (!ok && options.ContainsKey("commit"))
                    {
                        Console.Error.WriteLine("Refusing to commit: reconciliation failed.");
                        return 2;
                    }
                    return await ImportRunner.RunAsync(conn, email, data,
                        commit: options.ContainsKey("commit"),
                        reset: options.ContainsKey("reset"));
                }
                case "budget":
                {
                    var reference = ReferenceReader.Read(file);
                    var budgetData = BudgetReader.Read(file, reference.Members);
                    return await BudgetSeeder.RunAsync(conn, email, reference, budgetData,
                        commit: options.ContainsKey("commit"));
                }
                case "transactions":
                    TransactionSeeder.Verbose = options.ContainsKey("verbose");
                    return await TransactionSeeder.RunAsync(conn, email, file,
                        commit: options.ContainsKey("commit"));
                case "members":
                    return await MemberAttributor.RunAsync(conn, email, file,
                        commit: options.ContainsKey("commit"));
                case "convert-living":
                {
                    var from = options.GetValueOrDefault("from", $"{DateTime.Now:yyyy-MM}");
                    var parts = from.Split('-');
                    if (parts.Length != 2 || !int.TryParse(parts[0], out var fy) || !int.TryParse(parts[1], out var fm))
                    {
                        Console.Error.WriteLine("--from must be YYYY-MM (e.g. 2026-06).");
                        return 1;
                    }
                    return await DbCommands.ConvertLivingCostsToFunds(conn, email, fy, fm,
                        commit: options.ContainsKey("commit"));
                }
                default:
                    Console.WriteLine("Usage: AllotJar.Importer <verb> [args] [--file <path>] [--email <e>] [--conn <cs>]");
                    Console.WriteLine("  dump <sheet> [startRow] [endRow]   Print non-empty cells of a sheet.");
                    Console.WriteLine("  reconcile                          Tie reference data out to the sheet (read-only).");
                    Console.WriteLine("  status                             Show existing DB data for the owner (read-only).");
                    Console.WriteLine("  import [--commit] [--reset]        Reconcile, then (with --commit) write reference data.");
                    Console.WriteLine("  budget [--commit]                  Create the 12 budget months (needs reference data).");
                    Console.WriteLine("  transactions [--commit]            Import the 12 months of ledger rows + Visa (needs budget).");
                    Console.WriteLine("  members [--commit]                 Back-fill member attribution onto Visa tx from the per-person columns.");
                    Console.WriteLine("  convert-living [--from YYYY-MM] [--commit]  Turn 'Living Costs' into accumulating funds from that month on.");
                    return verb == "help" ? 0 : 1;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR: {ex.Message}");
            Console.Error.WriteLine(ex);
            return 1;
        }
    }

    /// <summary>Prints every non-empty cell (address, formula?, value) of a sheet in a row range.</summary>
    private static int Dump(string file, IReadOnlyList<string> positional)
    {
        if (positional.Count < 2)
        {
            Console.Error.WriteLine("dump requires a sheet name: dump \"<sheet>\" [startRow] [endRow]");
            return 1;
        }

        var sheetName = positional[1];
        int startRow = positional.Count > 2 ? int.Parse(positional[2]) : 1;
        int endRow = positional.Count > 3 ? int.Parse(positional[3]) : int.MaxValue;

        using var wb = Workbook.Open(file);
        if (!wb.TryGetWorksheet(sheetName, out var ws))
        {
            Console.Error.WriteLine($"Sheet '{sheetName}' not found. Available:");
            foreach (var s in wb.Worksheets)
            {
                Console.Error.WriteLine($"  - {s.Name}");
            }
            return 1;
        }

        var used = ws.RangeUsed();
        if (used is null)
        {
            Console.WriteLine("(sheet is empty)");
            return 0;
        }

        int lastRow = Math.Min(endRow, used.LastRow().RowNumber());
        for (int r = Math.Max(startRow, used.FirstRow().RowNumber()); r <= lastRow; r++)
        {
            var row = ws.Row(r);
            var cells = row.CellsUsed().ToList();
            if (cells.Count == 0)
            {
                continue;
            }

            var parts = cells.Select(c =>
            {
                var addr = c.Address.ColumnLetter + r;
                string val = SafeValue(c);
                return c.HasFormula
                    ? $"{addr}=[{val}] (=({Trunc(c.FormulaA1, 28)}))"
                    : $"{addr}={val}";
            });
            Console.WriteLine($"R{r}: " + string.Join(" | ", parts));
        }

        return 0;
    }

    /// <summary>Reads a cell's cached value without forcing a recalculation.</summary>
    private static string SafeValue(IXLCell cell)
    {
        try
        {
            var v = cell.CachedValue;
            if (v.IsBlank) return "";
            if (v.IsNumber) return v.GetNumber().ToString("0.####");
            if (v.IsDateTime) return v.GetDateTime().ToString("yyyy-MM-dd");
            if (v.IsText) return v.GetText();
            if (v.IsError) return "#" + v.GetError();
            return v.ToString() ?? "";
        }
        catch (Exception ex)
        {
            return $"<err:{ex.GetType().Name}>";
        }
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s.Substring(0, n) + "…";

    /// <summary>Splits args into positional values and --key value / --flag options.</summary>
    private static (List<string> positional, Dictionary<string, string> options) ParseArgs(string[] args)
    {
        var positional = new List<string>();
        var options = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith("--", StringComparison.Ordinal))
            {
                var key = args[i].Substring(2);
                if (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    options[key] = args[++i];
                }
                else
                {
                    options[key] = "true";
                }
            }
            else
            {
                positional.Add(args[i]);
            }
        }
        return (positional, options);
    }
}
