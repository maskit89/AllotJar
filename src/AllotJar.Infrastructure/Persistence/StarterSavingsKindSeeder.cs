using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Infrastructure.Persistence;

/// <summary>
/// One-off, idempotent repair for accounts registered before PR #142.
///
/// The registration <see cref="BudgetSeeder"/> used to create its starter "Savings" group
/// WITHOUT <c>Kind = CategoryKind.Savings</c>, so it defaulted to <see cref="CategoryKind.Expense"/>.
/// The lone "Emergency Fund" line therefore never rolled over month to month, never became a jar,
/// and was excluded from the savings maths. This backfill finds those untouched starter groups and
/// converts them into a real savings envelope: it flips the group to <see cref="CategoryKind.Savings"/>,
/// mints ONE backing <see cref="Jar"/> for the household via <see cref="SavingsLines.AddBackingJar"/>
/// (keeping the enforced <see cref="BudgetItem.SavingsId"/> → Jars.Id FK satisfied — a bare Guid would
/// violate it on SQL Server), and links every matching month's line to that same jar so its balance
/// rolls over the way a sinking fund should.
///
/// Deliberately conservative — this only touches data that is unmistakably the pristine starter seed,
/// and works at the granularity of a whole household:
///   * A household is repaired only if EVERY one of its "Savings"-named groups is still the pristine
///     starter shape (Expense-kind, a single unlinked, non-bill "Emergency Fund" line). If the user
///     renamed the group, expanded it, deleted/renamed the line, turned it into a bill, or already has
///     a proper jar-backed savings group, the whole household is skipped rather than guessed at.
///   * A household that already owns a jar named "Emergency Fund" is skipped (we can't tell which jar
///     the line should point at).
/// All of a household's Emergency Fund lines (one per budget month — later months are copies of the
/// starter) are the SAME logical fund, so they share ONE jar, exactly as a real sinking fund's
/// <see cref="BudgetItem.SavingsId"/> is stable across its monthly instances.
///
/// Idempotent: once converted, a household's groups are Kind=Savings with linked lines (no longer
/// pristine candidates) and it owns an "Emergency Fund" jar, so a second run is a no-op. Post-#142
/// registrations already have the correct shape and are likewise left untouched. Safe to run on every
/// boot, and non-fatal (see the caller in Program.cs).
/// </summary>
public static class StarterSavingsKindSeeder
{
    private const string SavingsGroupName = "Savings";
    private const string EmergencyFundName = "Emergency Fund";

    public static async Task BackfillAsync(ApplicationDbContext db, CancellationToken ct = default)
    {
        // Every "Savings"-named group in the database, with its lines and owning month (for OwnerId).
        // Tracked (not AsNoTracking) because qualifying groups/lines are mutated below.
        var savingsGroups = await db.BudgetCategories
            .Where(c => c.Name == SavingsGroupName)
            .Include(c => c.Items)
            .Include(c => c.BudgetMonth)
            .ToListAsync(ct);
        if (savingsGroups.Count == 0)
        {
            return;
        }

        // Households that already own an "Emergency Fund" jar — ambiguous, skip entirely.
        var ownersWithEmergencyJar = (await db.Jars
            .Where(j => j.Name == EmergencyFundName)
            .Select(j => j.OwnerId)
            .Distinct()
            .ToListAsync(ct))
            .ToHashSet();

        var changed = false;

        foreach (var household in savingsGroups.GroupBy(c => c.BudgetMonth.OwnerId))
        {
            var ownerId = household.Key;

            if (ownersWithEmergencyJar.Contains(ownerId))
            {
                continue;
            }

            // All-or-nothing: only repair when EVERY "Savings" group is the pristine starter shape.
            // Any deviation (already Savings-kind, expanded, renamed, made a bill, already linked)
            // means the household has moved on from the seed — leave it alone.
            var groups = household.ToList();
            if (!groups.All(IsPristineStarterSavings))
            {
                continue;
            }

            // One shared jar for the household's Emergency Fund; the helper keeps the FK invariant.
            var jar = SavingsLines.AddBackingJar(db, ownerId, EmergencyFundName);
            foreach (var group in groups)
            {
                group.Kind = CategoryKind.Savings;
                // Pristine ⇒ exactly one item (asserted by the gate); link it to the shared jar.
                group.Items.Single().SavingsId = jar.Id;
            }

            changed = true;
        }

        if (changed)
        {
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>
    /// True only for an untouched starter "Savings" group: still Expense-kind and holding exactly one
    /// unlinked, non-bill "Emergency Fund" line. Anything else signals the user has customised it.
    /// </summary>
    private static bool IsPristineStarterSavings(BudgetCategory group)
    {
        if (group.Kind != CategoryKind.Expense || group.Items.Count != 1)
        {
            return false;
        }

        var line = group.Items.Single();
        return line.Name == EmergencyFundName
            && line.SavingsId is null
            && line.DueDay is null;
    }
}
