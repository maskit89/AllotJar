using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Importer;

/// <summary>Read-only database inspection used before any write (the "look before you leap" step).</summary>
internal static class DbCommands
{
    /// <summary>
    /// Convert the "Living Costs" expense category into accumulating sinking funds, from the given
    /// month onward (leaving earlier months as monthly expenses so no untracked history inflates the
    /// jars). Per distinct line a no-target <see cref="Jar"/> is created, every monthly line
    /// from the start month on is linked to it, and the category flips to <see cref="CategoryKind.Savings"/>.
    /// Idempotent-ish: refuses if those categories are already Funds. Dry-run unless <paramref name="commit"/>.
    /// </summary>
    public static async Task<int> ConvertLivingCostsToFunds(
        string connectionString, string email, int fromYear, int fromMonth, bool commit)
    {
        await using var provider = ImporterHost.Build(connectionString);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        var normalized = email.ToUpperInvariant();
        var user = await db.Users.AsNoTracking().FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);
        if (user is null)
        {
            Console.Error.WriteLine($"Owner not found for '{email}'.");
            return 1;
        }
        var owner = user.Id;

        var categories = await db.BudgetCategories
            .Include(c => c.BudgetMonth)
            .Include(c => c.Items)
            .Where(c => c.BudgetMonth.OwnerId == owner
                        && c.Name == "Living Costs"
                        && (c.BudgetMonth.Year > fromYear
                            || (c.BudgetMonth.Year == fromYear && c.BudgetMonth.Month >= fromMonth)))
            .ToListAsync();

        if (categories.Count == 0)
        {
            Console.WriteLine($"No 'Living Costs' categories found from {fromYear}-{fromMonth:00} onward.");
            return 0;
        }

        // Safety: don't run twice (would double-create funds).
        var alreadyFund = categories.Count(c => c.Kind == CategoryKind.Savings);
        if (alreadyFund > 0)
        {
            Console.Error.WriteLine(
                $"Refusing: {alreadyFund} of {categories.Count} target categories are already Funds — looks already converted.");
            return 2;
        }

        var lineNames = categories
            .SelectMany(c => c.Items)
            .Select(i => i.Name)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToList();

        Console.WriteLine($"Owner   : {email}");
        Console.WriteLine($"Convert : 'Living Costs' → Fund, from {fromYear}-{fromMonth:00} onward");
        Console.WriteLine($"  Months affected    : {categories.Select(c => c.BudgetMonthId).Distinct().Count()}");
        Console.WriteLine($"  Jars (funds) to add: {lineNames.Count}");
        foreach (var n in lineNames)
        {
            Console.WriteLine($"    • {n}");
        }

        var fundByName = new Dictionary<string, Jar>(StringComparer.Ordinal);
        foreach (var name in lineNames)
        {
            var fund = new Jar
            {
                OwnerId = owner,
                Name = name,
                Kind = JarKind.Recurring,
                TargetAmount = 0m,                  // open-ended pool: no target, just accumulates
                TargetDate = null,
                Accrual = AccrualMethod.ProportionalPool,
                OpeningBalance = 0m,
            };
            fundByName[name] = fund;
            db.Jars.Add(fund);
        }

        var linesLinked = 0;
        foreach (var cat in categories)
        {
            cat.Kind = CategoryKind.Savings;
            foreach (var item in cat.Items)
            {
                if (item.SavingsId is null && fundByName.TryGetValue(item.Name, out var fund))
                {
                    item.SavingsId = fund.Id;
                    linesLinked++;
                }
            }
        }

        Console.WriteLine($"  Lines linked       : {linesLinked}");
        Console.WriteLine($"  Categories flipped : {categories.Count}");

        if (!commit)
        {
            Console.WriteLine("\nDRY RUN — nothing written. Re-run with --commit to apply.");
            return 0;
        }

        await db.SaveChangesAsync();
        Console.WriteLine("\nCOMMITTED.");
        return 0;
    }

    /// <summary>
    /// Resolves the household owner by email and prints how much AllotJar data already
    /// exists for them, so we know whether a commit would append to or collide with
    /// existing data. Purely read-only.
    /// </summary>
    public static async Task<int> Status(string connectionString, string email)
    {
        await using var provider = ImporterHost.Build(connectionString);
        using var scope = provider.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();

        Console.WriteLine($"Database : {connectionString}");
        if (!await db.Database.CanConnectAsync())
        {
            Console.Error.WriteLine("Cannot connect to the database.");
            return 1;
        }

        var normalized = email.ToUpperInvariant();
        var user = await db.Users
            .AsNoTracking()
            .FirstOrDefaultAsync(u => u.NormalizedEmail == normalized);

        if (user is null)
        {
            Console.WriteLine($"Owner    : NOT FOUND for '{email}'.");
            Console.WriteLine("Existing users:");
            foreach (var u in await db.Users.AsNoTracking().Select(u => u.Email).ToListAsync())
            {
                Console.WriteLine($"  - {u}");
            }
            return 1;
        }

        var owner = user.Id;
        Console.WriteLine($"Owner    : {email}  (id {owner})");
        Console.WriteLine();
        Console.WriteLine("Existing data for this owner:");
        Console.WriteLine($"  Accounts          : {await db.Accounts.CountAsync(a => a.OwnerId == owner)}");
        Console.WriteLine($"  Household members  : {await db.HouseholdMembers.CountAsync(m => m.OwnerId == owner)}");
        Console.WriteLine($"  Sinking funds      : {await db.Jars.CountAsync(f => f.OwnerId == owner)}");
        Console.WriteLine($"  Budget months      : {await db.BudgetMonths.CountAsync(m => m.OwnerId == owner)}");
        Console.WriteLine($"  Transactions       : {await db.Transactions.CountAsync(t => t.OwnerId == owner)}");
        Console.WriteLine($"  Allocation profiles: {await db.AllocationProfiles.CountAsync(p => p.OwnerId == owner)}");
        return 0;
    }
}
