using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Importer;

/// <summary>
/// Phase 2c — back-fills household-member attribution onto the already-imported Visa
/// transactions from the sheet's per-person columns (D = Liz, E = Alex; Marisa is not a
/// household member). A charge wholly one person's gets a whole-transaction MemberId; a
/// shared charge is converted to per-member <see cref="TransactionSplit"/> slices (Alex's
/// and Sam's shares attributed, the rest left unattributed). Account balances and budget
/// actuals are unchanged (slices keep the original budget line and sum to the total).
///
/// Idempotent: each run first collapses any splits it created and clears MemberId on the
/// Visa transactions, then re-applies — so it is safe to re-run. Dry-run unless --commit.
/// </summary>
internal static class MemberAttributor
{
    public static async Task<int> RunAsync(string conn, string email, string file, bool commit)
    {
        var shares = VisaShareReader.Read(file);

        await using var provider = ImporterHost.Build(conn);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        var normalized = email.ToUpperInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);
        if (user is null) { Console.Error.WriteLine($"Owner '{email}' not found."); return 1; }
        var owner = user.Id;

        var members = await db.HouseholdMembers.Where(m => m.OwnerId == owner && !m.IsArchived).ToListAsync();
        var alex = members.FirstOrDefault(m => m.Name.Trim().StartsWith("Alex", StringComparison.OrdinalIgnoreCase));
        var sam = members.FirstOrDefault(m => m.Name.Trim().StartsWith("Li", StringComparison.OrdinalIgnoreCase));
        if (alex is null || sam is null)
        {
            Console.Error.WriteLine($"Could not find both members (Alex / Sam). Found: {string.Join(", ", members.Select(m => m.Name))}");
            return 1;
        }
        Console.WriteLine($"  Members: Alex → '{alex.Name}', Liz column → '{sam.Name}'.");

        var visaAccount = await db.Accounts.FirstOrDefaultAsync(a => a.OwnerId == owner && a.Name == Ledger.VisaAccount);
        if (visaAccount is null) { Console.Error.WriteLine("Visa account not found — run the transactions phase first."); return 1; }

        // The Visa transactions in import order (BankReference seq), with their splits.
        var visaTx = await db.Transactions
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == owner && t.AccountId == visaAccount.Id)
            .ToListAsync();
        visaTx = visaTx.OrderBy(SeqOf).ToList();

        if (visaTx.Count != shares.Count)
        {
            Console.Error.WriteLine($"Alignment failed: {visaTx.Count} Visa transactions in DB vs {shares.Count} sheet rows. Re-run the transactions phase first.");
            return 2;
        }

        // Idempotent reset: collapse any splits we created and clear member tags.
        foreach (var t in visaTx)
        {
            if (t.Splits.Count > 0)
            {
                t.BudgetItemId = t.Splits.First().BudgetItemId; // every slice we make shares the one line
                db.TransactionSplits.RemoveRange(t.Splits);
                t.Splits.Clear();
            }
            t.MemberId = null;
        }

        int soloChris = 0, soloLiza = 0, split = 0, skippedZero = 0, skippedIncome = 0;
        decimal toChris = 0m, toLiza = 0m, unattributed = 0m;
        var samples = new List<string>();

        for (int i = 0; i < visaTx.Count; i++)
        {
            var t = visaTx[i];
            var s = shares[i];

            // Cross-check the pairing — amount must match (abs of the sheet's col C).
            if (Math.Abs(t.Amount - s.Total) > 0.01m)
            {
                Console.Error.WriteLine($"Alignment mismatch at #{i}: tx {t.Amount:0.00} ({t.Payee}) vs sheet {s.Total:0.00} ({s.Details}). Aborting.");
                return 2;
            }

            if (t.Type != TransactionType.Expense) { skippedIncome++; continue; }

            var total = t.Amount;
            var cShare = Math.Min(s.Alex, total);
            var lShare = Math.Min(s.Liz, total - cShare);
            var remainder = total - cShare - lShare; // Marisa + any rounding → unattributed

            if (cShare == total)
            {
                t.MemberId = alex.Id;
                soloChris++;
                toChris += total;
            }
            else if (lShare == total)
            {
                t.MemberId = sam.Id;
                soloLiza++;
                toLiza += total;
            }
            else if (cShare == 0m && lShare == 0m)
            {
                skippedZero++; // nothing for the household (e.g. wholly Marisa, or no split filled in)
                unattributed += remainder;
            }
            else
            {
                var line = t.BudgetItemId; // preserve the budget-line attribution on every slice
                t.BudgetItemId = null;
                if (cShare > 0m) { db.TransactionSplits.Add(Slice(t.Id, line, alex.Id, cShare)); toChris += cShare; }
                if (lShare > 0m) { db.TransactionSplits.Add(Slice(t.Id, line, sam.Id, lShare)); toLiza += lShare; }
                if (remainder > 0m) { db.TransactionSplits.Add(Slice(t.Id, line, null, remainder)); unattributed += remainder; }
                split++;
                if (samples.Count < 8)
                    samples.Add($"    {t.Date} {Trunc(t.Payee, 24),-24} {total,8:0.00} → Alex {cShare:0.00} / Sam {lShare:0.00}" + (remainder > 0 ? $" / (other) {remainder:0.00}" : ""));
            }
        }

        Console.WriteLine();
        Console.WriteLine("MEMBER ATTRIBUTION (Visa per-person columns)");
        Console.WriteLine($"  Whole-charge Alex : {soloChris}");
        Console.WriteLine($"  Whole-charge Sam  : {soloLiza}");
        Console.WriteLine($"  Shared (split)     : {split}");
        Console.WriteLine($"  Skipped (no household share) : {skippedZero}");
        Console.WriteLine($"  Skipped (payments/income)    : {skippedIncome}");
        Console.WriteLine($"  Attributed to Alex : {toChris,12:#,##0.00}");
        Console.WriteLine($"  Attributed to Sam  : {toLiza,12:#,##0.00}");
        Console.WriteLine($"  Left unattributed   : {unattributed,12:#,##0.00}");
        if (samples.Count > 0)
        {
            Console.WriteLine("  Sample shared charges:");
            foreach (var line in samples) Console.WriteLine(line);
        }

        if (!commit)
        {
            Console.WriteLine();
            Console.WriteLine("DRY RUN — nothing written. Re-run with --commit.");
            return 0;
        }

        await db.SaveChangesAsync();
        Console.WriteLine();
        Console.WriteLine("COMMITTED — member attribution written to the Visa transactions.");
        return 0;
    }

    private static TransactionSplit Slice(Guid txId, Guid? budgetItemId, Guid? memberId, decimal amount) =>
        new() { TransactionId = txId, BudgetItemId = budgetItemId, MemberId = memberId, Amount = amount };

    /// <summary>The import seq encoded in "xlsx:{mm}:Visa:{seq}" (sorts Visa tx into sheet-row order).</summary>
    private static int SeqOf(Transaction t)
    {
        var bankRef = t.BankReference;
        if (bankRef is null) return int.MaxValue;
        var idx = bankRef.LastIndexOf(':');
        return idx >= 0 && int.TryParse(bankRef[(idx + 1)..], out var n) ? n : int.MaxValue;
    }

    private static string Trunc(string s, int n) => s.Length <= n ? s : s[..n];
}
