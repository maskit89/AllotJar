using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Budgets;

/// <summary>
/// The household's one budget currency (rules 63/85): chosen up front and used by every budget
/// month, account and counted transaction. It is the currency the household's first budget
/// month was created in; before there is any month it is the owner's chosen currency (set at
/// sign-up), falling back to EUR. Once the household holds any account, month or transaction
/// the currency is fixed (<see cref="IsFixedAsync"/>): changing it would relabel recorded money,
/// an implicit 1:1 conversion (rule 42).
/// </summary>
public static class BudgetCurrency
{
    public static async Task<CurrencyCode> ResolveAsync(
        IApplicationDbContext db, IIdentityService? identity, string ownerId, CancellationToken cancellationToken)
    {
        var first = await db.BudgetMonths
            .AsNoTracking()
            .Where(m => m.OwnerId == ownerId)
            .OrderBy(m => m.Year)
            .ThenBy(m => m.Month)
            .Select(m => m.BaseCurrency)
            .FirstOrDefaultAsync(cancellationToken);
        if (first is not null)
        {
            return first;
        }

        return (identity is null ? null : await identity.GetPreferredCurrencyAsync(ownerId)) ?? CurrencyCode.Eur;
    }

    /// <summary>
    /// True once the household holds anything recorded in its currency: an account, a budget
    /// month or a transaction. Reads past the privacy filters, since another login's private
    /// account is still in the household's currency.
    /// </summary>
    public static async Task<bool> IsFixedAsync(
        IApplicationDbContext db, string ownerId, CancellationToken cancellationToken) =>
        await db.BudgetMonths.AnyAsync(m => m.OwnerId == ownerId, cancellationToken)
        || await db.Accounts.IgnoreQueryFilters().AnyAsync(a => a.OwnerId == ownerId, cancellationToken)
        || await db.Transactions.IgnoreQueryFilters().AnyAsync(t => t.OwnerId == ownerId, cancellationToken);
}
