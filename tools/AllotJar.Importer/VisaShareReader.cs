using ClosedXML.Excel;
using AllotJar.Domain.Enums;

namespace AllotJar.Importer;

/// <summary>One Visa charge's per-person split, in the same row order the ledger imports them.</summary>
internal sealed record VisaShare(
    DateOnly Date, string Details, decimal Total, decimal Liz, decimal Alex, decimal Marisa, TransactionType Type);

/// <summary>
/// Reads the "Visa" sheet's per-person columns (C total, D = Liz, E = Alex, F = Marisa) that
/// the main <see cref="Ledger"/> import deliberately ignores. The iteration mirrors
/// <c>Ledger.ReadVisa</c> exactly (rows 12..200, same blank/zero skipping), so the produced
/// list is 1:1 and in the same order as the imported Visa transactions — letting the member
/// back-fill pair each charge to its transaction (cross-checked on amount).
/// </summary>
internal static class VisaShareReader
{
    public static IReadOnlyList<VisaShare> Read(string file)
    {
        using var wb = Workbook.Open(file);
        var shares = new List<VisaShare>();
        if (!wb.TryGetWorksheet("Visa", out var ws)) return shares;

        for (int r = 12; r <= 200; r++)
        {
            var amount = NumberAt(ws, r, 3); // col C — total charge
            var details = TextAt(ws, r, 2);  // col B
            if (amount == 0m && string.IsNullOrWhiteSpace(details))
            {
                if (NumberAt(ws, r + 1, 3) == 0m && string.IsNullOrWhiteSpace(TextAt(ws, r + 1, 2))) break;
                continue;
            }
            if (amount == 0m) continue;

            var date = DateAt(ws, r, 1) ?? new DateOnly(2026, 1, 15);
            var type = amount > 0m ? TransactionType.Expense : TransactionType.Income;
            shares.Add(new VisaShare(
                date, details,
                Total: Math.Abs(amount),
                Liz: Math.Max(0m, NumberAt(ws, r, 4)),   // col D
                Alex: Math.Max(0m, NumberAt(ws, r, 5)),  // col E
                Marisa: Math.Max(0m, NumberAt(ws, r, 6)), // col F
                Type: type));
        }
        return shares;
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
}
