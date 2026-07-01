using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Importer;

/// <summary>
/// Phase 2b — the transactions. Imports every ledger movement (5 bank/cash blocks across
/// the 12 month sheets + the Visa card) as a Transaction on its account, and attributes
/// Savings-Joint living-cost spends to their budget line via the envelope code. Built by
/// direct entity construction (not CreateTransactionCommand) to keep full control of the
/// account/line attribution and skip the auto-categoriser. Reconciles each account's
/// running balance to the spreadsheet's monthly TOTAL (row 128) — the explicit oracle.
/// </summary>
internal static class TransactionSeeder
{
    public static bool Verbose { get; set; }

    public static async Task<int> RunAsync(string conn, string email, string file, bool commit)
    {
        var reference = ReferenceReader.Read(file);
        var budgetData = BudgetReader.Read(file, reference.Members);
        var ledger = Ledger.Read(file);

        var openings = reference.Accounts.ToDictionary(a => a.Name, a => a.Opening, StringComparer.OrdinalIgnoreCase);
        openings[Ledger.VisaAccount] = 0m;

        var reconciled = Reconcile(ledger, openings);

        if (!commit)
        {
            Console.WriteLine();
            Console.WriteLine($"DRY RUN — parsed {ledger.Rows.Count} transactions; nothing written. Re-run with --commit.");
            return reconciled ? 0 : 2;
        }

        await using var provider = ImporterHost.Build(conn);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var currentUser = provider.GetRequiredService<ImporterCurrentUser>();

        var normalized = email.ToUpperInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);
        if (user is null) { Console.Error.WriteLine($"Owner '{email}' not found."); return 1; }
        var owner = user.Id;
        currentUser.UserId = owner;

        // Accounts (create the Visa card if the reference phase didn't).
        var accounts = await db.Accounts.Where(a => a.OwnerId == owner).ToListAsync();
        if (accounts.All(a => !a.Name.Equals(Ledger.VisaAccount, StringComparison.OrdinalIgnoreCase)))
        {
            var visa = new Account
            {
                OwnerId = owner, Name = Ledger.VisaAccount, Type = AccountType.CreditCard,
                Currency = CurrencyCode.Eur, OpeningBalance = 0m,
                DisplayOrder = accounts.Count == 0 ? 0 : accounts.Max(a => a.DisplayOrder) + 1,
            };
            db.Accounts.Add(visa);
            await db.SaveChangesAsync();
            accounts.Add(visa);
            Console.WriteLine("  Created the Visa account (CreditCard).");
        }
        var accountIdByName = accounts.ToDictionary(a => a.Name, a => a.Id, StringComparer.OrdinalIgnoreCase);

        // Living-cost budget lines for code attribution: (month, line name) → item (tracked so we can flip its mode).
        var months = await db.BudgetMonths
            .Where(m => m.OwnerId == owner)
            .Include(m => m.Categories).ThenInclude(c => c.Items)
            .ToListAsync();
        BudgetItem? Line(int month, string category, string name) => months
            .FirstOrDefault(m => m.Month == month)?.Categories
            .FirstOrDefault(c => c.Name == category)?.Items
            .FirstOrDefault(i => i.Name == name);

        var lineNameByCode = budgetData.LivingLines.ToDictionary(
            l => l.Code.ToUpperInvariant(), l => l.Name, StringComparer.OrdinalIgnoreCase);

        // Fund names grouped for the payee-matched "guess the jar" attribution.
        var yearlyByCategory = reference.Funds.Where(f => f.Accrual == AccrualMethod.ProportionalPool)
            .GroupBy(f => f.Category)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<string>)g.Select(f => f.Name).ToList(),
                StringComparer.OrdinalIgnoreCase);
        var monthlyNames = (IReadOnlyList<string>)reference.Funds
            .Where(f => f.Accrual == AccrualMethod.StraightLine).Select(f => f.Name).ToList();

        // Idempotent re-import: clear this owner's transactions first.
        await db.TransactionSplits.Where(s => s.Transaction.OwnerId == owner).ExecuteDeleteAsync();
        var removed = await db.Transactions.Where(t => t.OwnerId == owner).ExecuteDeleteAsync();
        if (removed > 0) Console.WriteLine($"  Cleared {removed} existing transactions.");

        int living = 0, yearly = 0, monthly = 0, seq = 0;
        foreach (var row in ledger.Rows)
        {
            if (!accountIdByName.TryGetValue(row.Account, out var accountId)) continue;

            // Attribute the spend to a budget line, in priority order:
            //   1. living-cost code → its Living Costs line (exact);
            //   2. yearly-fund code → the best-matching fund in that category (guessed by payee);
            //   3. otherwise → the best-matching monthly commitment fund (guessed by payee).
            BudgetItem? target = null;
            if (row.Type == TransactionType.Expense)
            {
                if (row.Code is { } code && lineNameByCode.TryGetValue(code, out var lineName))
                {
                    target = Line(row.Month, "Living Costs", lineName);
                    if (target != null) living++;
                }
                else if (row.Code is { } yc && FundMatcher.YearlyCodeToCategory.TryGetValue(yc, out var cat)
                    && yearlyByCategory.TryGetValue(cat, out var cands)
                    && FundMatcher.Best(row.Payee, cands) is { } yname)
                {
                    target = Line(row.Month, "Yearly Funds", yname);
                    if (target != null) yearly++;
                }
                else if (row.Code is null && FundMatcher.Best(row.Payee, monthlyNames) is { } mname)
                {
                    target = Line(row.Month, "Monthly Commitments", mname);
                    if (target != null) monthly++;
                }
            }

            Guid? budgetItemId = null;
            if (target != null)
            {
                budgetItemId = target.Id;
            }

            db.Transactions.Add(new Transaction
            {
                OwnerId = owner,
                AccountId = accountId,
                BudgetItemId = budgetItemId,
                Amount = row.Amount,
                Type = row.Type,
                Date = row.Date,
                Payee = row.Payee,
                Currency = CurrencyCode.Eur,
                ExchangeRate = 1m,
                BankReference = $"xlsx:{row.Month:D2}:{row.Account}:{seq++}",
            });
        }
        await db.SaveChangesAsync();
        Console.WriteLine($"  Imported {ledger.Rows.Count} transactions — attributed: "
            + $"{living} living-cost, {yearly} yearly-fund, {monthly} monthly-commitment "
            + $"({living + yearly + monthly} of {ledger.Rows.Count}).");

        return await VerifyAsync(db, owner, ledger, openings) ? 0 : 2;
    }

    // --- Parse-side reconciliation (no DB) ----------------------------------
    private static bool Reconcile(LedgerData ledger, IReadOnlyDictionary<string, decimal> openings)
    {
        Console.WriteLine();
        Console.WriteLine("TRANSACTION RECONCILIATION (running balance vs each month's TOTAL, row 128)");
        Console.WriteLine($"  {"Account",-26} {"final running",14} {"sheet close",14} {"Δ",10}  Result");

        var accounts = openings.Keys.Where(a => a != Ledger.VisaAccount).ToList();
        var allOk = true;
        foreach (var account in accounts)
        {
            decimal running = openings[account];
            decimal lastClose = openings[account];
            int mismatches = 0;
            for (int month = 1; month <= 12; month++)
            {
                running += ledger.Rows
                    .Where(r => r.Month == month && r.Account == account)
                    .Sum(r => r.Type == TransactionType.Income ? r.Amount : -r.Amount);
                if (ledger.MonthlyClose.TryGetValue((month, account), out var close))
                {
                    lastClose = close;
                    if (Math.Abs(running - close) > 0.01m) mismatches++;
                }
            }
            var finalRunning = running;
            var delta = finalRunning - lastClose;
            var ok = Math.Abs(delta) <= 0.05m && mismatches == 0;
            allOk &= ok;
            var note = mismatches > 0 ? $"  ({mismatches} month(s) off)" : "";
            Console.WriteLine($"  {account,-26} {finalRunning,14:#,##0.00} {lastClose,14:#,##0.00} {delta,10:#,##0.00}  {(ok ? "OK" : "*** MISMATCH ***")}{note}");

            if (!ok && Verbose)
            {
                decimal run2 = openings[account];
                for (int month = 1; month <= 12; month++)
                {
                    var net = ledger.Rows.Where(r => r.Month == month && r.Account == account)
                        .Sum(r => r.Type == TransactionType.Income ? r.Amount : -r.Amount);
                    run2 += net;
                    if (ledger.MonthlyClose.TryGetValue((month, account), out var c))
                        Console.WriteLine($"      m{month:D2} running {run2,12:#,##0.00}  close {c,12:#,##0.00}  Δ {run2 - c,9:#,##0.00}");
                }
            }
        }

        // Visa: balance owed = −(running). Charges (expense) grow debt, payments (income) shrink it.
        var visaBalance = ledger.Rows.Where(r => r.Account == Ledger.VisaAccount)
            .Sum(r => r.Type == TransactionType.Income ? r.Amount : -r.Amount);
        var visaOk = Math.Abs(-visaBalance - ledger.VisaOwed) <= 0.05m;
        allOk &= visaOk;
        Console.WriteLine($"  {"Visa (owed)",-26} {-visaBalance,14:#,##0.00} {ledger.VisaOwed,14:#,##0.00} {(-visaBalance - ledger.VisaOwed),10:#,##0.00}  {(visaOk ? "OK" : "*** MISMATCH ***")}");

        Console.WriteLine();
        Console.WriteLine(allOk
            ? "TRANSACTION RECONCILIATION PASSED — every account ties to its monthly TOTAL."
            : "TRANSACTION RECONCILIATION FAILED — see mismatches above.");
        return allOk;
    }

    // --- DB read-back verification ------------------------------------------
    private static async Task<bool> VerifyAsync(
        ApplicationDbContext db, string owner, LedgerData ledger, IReadOnlyDictionary<string, decimal> openings)
    {
        var accounts = await db.Accounts.AsNoTracking().Where(a => a.OwnerId == owner).ToListAsync();
        var sums = await db.Transactions.AsNoTracking()
            .Where(t => t.OwnerId == owner && t.AccountId != null)
            .GroupBy(t => t.AccountId!.Value)
            .Select(g => new
            {
                AccountId = g.Key,
                Income = g.Where(t => t.Type == TransactionType.Income).Sum(t => t.Amount),
                Expense = g.Where(t => t.Type == TransactionType.Expense).Sum(t => t.Amount),
            })
            .ToDictionaryAsync(x => x.AccountId);

        Console.WriteLine();
        Console.WriteLine("VERIFY (database account balances vs spreadsheet final TOTAL)");
        var ok = true;
        foreach (var a in accounts.OrderBy(a => a.DisplayOrder))
        {
            var s = sums.GetValueOrDefault(a.Id);
            var balance = a.OpeningBalance + (s?.Income ?? 0m) - (s?.Expense ?? 0m);
            decimal expected = a.Name.Equals(Ledger.VisaAccount, StringComparison.OrdinalIgnoreCase)
                ? -ledger.VisaOwed
                : LastClose(ledger, a.Name, openings.GetValueOrDefault(a.Name));
            var rowOk = Math.Abs(balance - expected) <= 0.05m;
            ok &= rowOk;
            Console.WriteLine($"  {a.Name,-26} db={balance,14:#,##0.00}  sheet={expected,14:#,##0.00}  {(rowOk ? "OK" : "*** MISMATCH ***")}");
        }

        Console.WriteLine();
        Console.WriteLine(ok ? "TRANSACTIONS VERIFIED — database balances match the spreadsheet."
                             : "TRANSACTION MISMATCH — investigate.");
        return ok;
    }

    private static decimal LastClose(LedgerData ledger, string account, decimal opening)
    {
        decimal close = opening;
        for (int month = 1; month <= 12; month++)
            if (ledger.MonthlyClose.TryGetValue((month, account), out var c))
                close = c;
        return close;
    }
}
