using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Jars;

/// <summary>
/// The one read path for <see cref="JarDto"/>s: the ledger as of the date and as of the end
/// of the previous month (rule 14's "contributed this month"), plus the month's stored
/// savings lines (its plans). Every handler that returns a jar goes through here so the card
/// never changes between the write that returned it and the next load.
/// </summary>
public static class JarFigures
{
    public static async Task<IReadOnlyList<JarDto>> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Jar> jars,
        DateOnly asOf,
        CancellationToken cancellationToken,
        IReadOnlyCollection<Guid>? accountIds = null)
    {
        if (jars.Count == 0)
        {
            return Array.Empty<JarDto>();
        }

        // Actual money only (rule 1): each jar's allocations in its account as of the date, and
        // as the month began.
        var monthStart = new DateOnly(asOf.Year, asOf.Month, 1);
        var now = await JarLedgerReader.ReadAsync(db, ownerId, asOf, cancellationToken, accountIds);
        var before = await JarLedgerReader.ReadAsync(db, ownerId, monthStart.AddDays(-1), cancellationToken, accountIds);

        var ids = jars.Select(j => j.Id).ToList();
        var storedPlans = await db.BudgetItems
            .AsNoTracking()
            .Where(i => i.SavingsId != null && ids.Contains(i.SavingsId.Value)
                        && i.BudgetCategory.BudgetMonth.OwnerId == ownerId
                        && i.BudgetCategory.BudgetMonth.Year == asOf.Year
                        && i.BudgetCategory.BudgetMonth.Month == asOf.Month)
            .GroupBy(i => i.SavingsId!.Value)
            .Select(g => new { JarId = g.Key, Planned = g.Sum(i => i.PlannedAmount) })
            .ToDictionaryAsync(x => x.JarId, x => x.Planned, cancellationToken);

        return jars
            .Select(j => j.ToDto(
                now.BalanceOf(j.Id),
                before.BalanceOf(j.Id),
                storedPlans.TryGetValue(j.Id, out var planned) ? planned : null,
                asOf))
            .ToList();
    }

    public static async Task<JarDto> ReadOneAsync(
        IApplicationDbContext db, string ownerId, Jar jar, DateOnly asOf, CancellationToken cancellationToken)
        => (await ReadAsync(db, ownerId, new[] { jar }, asOf, cancellationToken, new[] { jar.FundingAccountId }))[0];
}
