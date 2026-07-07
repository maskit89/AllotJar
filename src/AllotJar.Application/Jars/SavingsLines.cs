using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars;

/// <summary>
/// The jar ↔ savings-line invariant, in one place: every Savings-kind budget line
/// references a real <see cref="Jar"/> (BudgetItems.SavingsId is an enforced FK to
/// Jars.Id), and a jar's monthly contribution is such a line. Every SavingsId writer
/// goes through here — minting a bare Guid passes the EF InMemory tests but violates
/// the constraint on SQL Server.
///
/// New rows are added through the DbSets with explicit FKs (never by mutating a
/// tracked month's navigation collections, which would attach the client-keyed
/// entities as Modified instead of Added). That also works for a month that is
/// itself still pending insert: ids are client-generated, so the FK values exist
/// before SaveChanges orders the inserts.
/// </summary>
public static class SavingsLines
{
    /// <summary>Mints and stages the backing jar for a savings line; returns it for its id.</summary>
    public static Jar AddBackingJar(IApplicationDbContext db, string ownerId, string lineName)
    {
        var jar = Jar.ForSavingsLine(ownerId, lineName);
        db.Jars.Add(jar);
        return jar;
    }

    /// <summary>
    /// Appends <paramref name="jar"/>'s contribution line to the month's first Savings
    /// group, creating a "Savings" group when the month has none. The month's categories
    /// (with items) must be loaded/built on the instance; reading them is all this does.
    /// </summary>
    public static void AppendJarLine(IApplicationDbContext db, BudgetMonth month, Jar jar, decimal planned)
    {
        var savings = month.Categories
            .Where(c => c.Kind == CategoryKind.Savings)
            .OrderBy(c => c.DisplayOrder)
            .FirstOrDefault();
        if (savings is null)
        {
            savings = new BudgetCategory
            {
                BudgetMonthId = month.Id,
                Name = "Savings",
                Kind = CategoryKind.Savings,
                // Display order is contiguous per kind, and this is the first Savings group.
                DisplayOrder = 0,
            };
            db.BudgetCategories.Add(savings);
            // Also attach to the in-memory graph (safe: the explicit Add above pinned
            // the state) so a subsequent call for the same month finds the group.
            month.Categories.Add(savings);
        }

        var line = new BudgetItem
        {
            BudgetCategoryId = savings.Id,
            Name = jar.Name,
            PlannedAmount = planned,
            DisplayOrder = savings.Items.Count == 0 ? 0 : savings.Items.Max(i => i.DisplayOrder) + 1,
            SavingsId = jar.Id,
        };
        db.BudgetItems.Add(line);
        savings.Items.Add(line);
    }
}
