using MediatR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using ZeroBudget.Application.Accounts.Commands.CreateAccount;
using ZeroBudget.Application.Household.Commands.CreateHouseholdMember;
using ZeroBudget.Application.Jars.Commands.CreateJar;
using ZeroBudget.Domain.Enums;
using ZeroBudget.Infrastructure.Persistence;

namespace ZeroBudget.Importer;

/// <summary>
/// Writes the parsed reference data (accounts, members, sinking funds) into the database
/// by sending the same Application commands the API uses, then reads it back and verifies
/// the stored totals still tie out to the spreadsheet. With <c>commit: false</c> it only
/// previews; with <c>reset: true</c> it first wipes the owner's existing budgeting data
/// so the import is a clean 1:1 copy of the sheet.
/// </summary>
internal static class ImportRunner
{
    private static readonly DateOnly OpeningAsOf = new(2025, 12, 31);

    public static async Task<int> RunAsync(string conn, string email, ReferenceData data, bool commit, bool reset)
    {
        if (!commit)
        {
            Console.WriteLine();
            Console.WriteLine("DRY RUN — no database changes were made.");
            Console.WriteLine("  Re-run with --commit to write the reference data.");
            Console.WriteLine("  Add --reset to first delete the owner's existing ZeroBudget data (clean import).");
            return 0;
        }

        await using var provider = ImporterHost.Build(conn);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var sender = scope.ServiceProvider.GetRequiredService<ISender>();
        var currentUser = provider.GetRequiredService<ImporterCurrentUser>();

        var normalized = email.ToUpperInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);
        if (user is null)
        {
            Console.Error.WriteLine($"Owner '{email}' not found — cannot import. Run `status` to list users.");
            return 1;
        }

        var owner = user.Id;
        currentUser.UserId = owner;
        Console.WriteLine();
        Console.WriteLine($"COMMIT as {email} (id {owner})");

        if (reset)
        {
            var summary = await WipeOwnerAsync(db, owner);
            Console.WriteLine($"  Reset: deleted {summary}.");
        }

        // 1) Accounts first — members and (future) reconciliation reference them by id.
        var accountIdByName = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in data.Accounts)
        {
            var dto = await sender.Send(new CreateAccountCommand(a.Name, a.Type, "EUR", a.Opening));
            accountIdByName[a.Name] = dto.Id;
        }
        Console.WriteLine($"  Created {data.Accounts.Count} accounts.");

        // 2) Members, each linked to their personal savings account.
        foreach (var m in data.Members)
        {
            Guid? savings = accountIdByName.TryGetValue(m.SavingsAccountName, out var id) ? id : null;
            await sender.Send(new CreateHouseholdMemberCommand(m.Name, m.NetMonthlyIncome, savings));
        }
        Console.WriteLine($"  Created {data.Members.Count} household members.");

        // 3) Sinking funds with their targets, accrual method and 2026 opening balances.
        foreach (var f in data.Funds)
        {
            await sender.Send(new CreateJarCommand(
                Name: f.Name,
                Kind: JarKind.Recurring,
                TargetAmount: f.TargetAmount,
                TargetDate: null,
                CoverStart: f.CoverStart,
                CoverEnd: f.CoverEnd,
                Accrual: f.Accrual,
                OpeningBalance: f.Opening,
                OpeningAsOf: OpeningAsOf,
                FundingAccountId: null));
        }
        Console.WriteLine($"  Created {data.Funds.Count} sinking funds.");

        return await VerifyAsync(db, owner, data) ? 0 : 2;
    }

    /// <summary>Reads the committed data back and confirms its totals still match the parsed sheet figures.</summary>
    private static async Task<bool> VerifyAsync(ApplicationDbContext db, string owner, ReferenceData data)
    {
        var accounts = await db.Accounts.AsNoTracking().Where(a => a.OwnerId == owner).ToListAsync();
        var members = await db.HouseholdMembers.AsNoTracking().Where(m => m.OwnerId == owner).ToListAsync();
        var funds = await db.Jars.AsNoTracking().Where(f => f.OwnerId == owner).ToListAsync();

        Console.WriteLine();
        Console.WriteLine("VERIFY (database read-back vs parsed sheet)");
        var ok = true;
        ok &= Row("Accounts: count", accounts.Count, data.Accounts.Count);
        ok &= Row("Accounts: Σ opening", accounts.Sum(a => a.OpeningBalance), data.Accounts.Sum(a => a.Opening));
        ok &= Row("Members: count", members.Count, data.Members.Count);
        ok &= Row("Members: Σ net income", members.Sum(m => m.NetMonthlyIncome), data.Members.Sum(m => m.NetMonthlyIncome));
        ok &= Row("Funds: count", funds.Count, data.Funds.Count);
        ok &= Row("Funds: Σ target", funds.Sum(f => f.TargetAmount), data.Funds.Sum(f => f.TargetAmount));
        ok &= Row("Funds: Σ opening", funds.Sum(f => f.OpeningBalance), data.Funds.Sum(f => f.Opening));

        Console.WriteLine();
        Console.WriteLine(ok
            ? "IMPORT VERIFIED — the database matches the spreadsheet reference data."
            : "IMPORT MISMATCH — the database does not match; investigate before proceeding.");
        return ok;

        static bool Row(string label, decimal actual, decimal expected)
        {
            var ok = Math.Abs(actual - expected) <= 0.05m;
            Console.WriteLine($"  {label,-24} db={actual,14:#,##0.00}  sheet={expected,14:#,##0.00}  {(ok ? "OK" : "*** MISMATCH ***")}");
            return ok;
        }
    }

    /// <summary>
    /// Deletes every ZeroBudget row owned by <paramref name="owner"/>, child tables first so
    /// foreign keys stay satisfied. Identity (login) rows are untouched.
    /// </summary>
    private static async Task<string> WipeOwnerAsync(ApplicationDbContext db, string owner)
    {
        var splits = await db.TransactionSplits.Where(s => s.Transaction.OwnerId == owner).ExecuteDeleteAsync();
        var tx = await db.Transactions.Where(t => t.OwnerId == owner).ExecuteDeleteAsync();
        await db.AllocationRules.Where(r => r.AllocationProfile.OwnerId == owner).ExecuteDeleteAsync();
        var profiles = await db.AllocationProfiles.Where(p => p.OwnerId == owner).ExecuteDeleteAsync();
        await db.BudgetItems.Where(i => i.BudgetCategory.BudgetMonth.OwnerId == owner).ExecuteDeleteAsync();
        await db.BudgetCategories.Where(c => c.BudgetMonth.OwnerId == owner).ExecuteDeleteAsync();
        var months = await db.BudgetMonths.Where(m => m.OwnerId == owner).ExecuteDeleteAsync();
        var funds = await db.Jars.Where(f => f.OwnerId == owner).ExecuteDeleteAsync();
        var members = await db.HouseholdMembers.Where(m => m.OwnerId == owner).ExecuteDeleteAsync();
        var accounts = await db.Accounts.Where(a => a.OwnerId == owner).ExecuteDeleteAsync();

        return $"{accounts} accounts, {members} members, {funds} funds, {months} budget months, "
            + $"{tx} transactions ({splits} splits), {profiles} allocation profiles";
    }
}
