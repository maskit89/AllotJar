using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions;

/// <summary>
/// The single place the refund link is validated (rules 38/39), so create, link and edit
/// cannot drift. A refund is money received (an <see cref="TransactionType.Income"/> row that
/// credits its account on its own date) linked to the purchase it comes back from. The
/// original must be one of the user's own expenses — never a transfer, never itself a refund —
/// the refund cannot be dated before the purchase, and the refunds of one purchase can never
/// add up to more than was paid (a partial refund is fine; a refund of more than the purchase
/// is a mistake, or income). Both rows stay in history; nothing is netted away.
/// </summary>
public static class RefundRules
{
    /// <summary>The error key every refund-link refusal reports under.</summary>
    public const string Key = "RefundOfTransactionId";

    /// <summary>
    /// Load the purchase a refund points at and check that <paramref name="refundAmount"/> in
    /// <paramref name="refundCurrency"/> received on <paramref name="refundDate"/> can be a
    /// refund of it. <paramref name="refundId"/> is the refund's own id when it already exists,
    /// so its stored amount is not counted against itself.
    /// </summary>
    public static async Task<Transaction> ValidateOriginalAsync(
        IApplicationDbContext db,
        string userId,
        Guid originalId,
        Guid? refundId,
        DateOnly refundDate,
        decimal refundAmount,
        Domain.ValueObjects.CurrencyCode refundCurrency,
        decimal refundExchangeRate,
        CancellationToken cancellationToken)
    {
        if (refundId is not null && refundId == originalId)
        {
            throw Refuse("A transaction can't be a refund of itself.");
        }

        var original = await db.Transactions
            .FirstOrDefaultAsync(t => t.Id == originalId, cancellationToken);
        if (original is null)
        {
            throw new NotFoundException($"Transaction {originalId} was not found.");
        }
        if (original.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        // A refund is Income-typed, so ask this before the direction check to give the useful message.
        if (original.IsRefund)
        {
            throw Refuse("A refund can't itself be refunded. Link this to the original purchase instead.");
        }
        if (original.Type != TransactionType.Expense)
        {
            throw Refuse(original.Type == TransactionType.Transfer
                ? "A transfer can't be refunded; a refund comes back from a purchase."
                : "Only a purchase can be refunded; this transaction is money received.");
        }
        if (refundDate < original.Date)
        {
            throw Refuse($"A refund can't be dated before the purchase it refunds ({original.Date:d MMM yyyy}).");
        }

        // Refunds of one purchase never exceed it — counting the ones the caller can't see (W13).
        var others = (await AllRefundsAsync(db, originalId, cancellationToken)).Where(r => r.Id != refundId).ToList();
        var legs = others.Select(r => r.Leg).Append(new RefundLeg(refundAmount, refundCurrency, refundExchangeRate)).ToList();
        var (paid, refunded, sameCurrency) = Totals(original.Currency, original.Amount, original.ExchangeRate, legs);
        if (refunded > paid)
        {
            if (others.Any(r => r.Hidden))
            {
                // Say no more than that it doesn't fit: the other refunds' amounts are private.
                throw Refuse($"This refund doesn't fit: refunds of this purchase can't add up to more than the {paid:0.##} paid.");
            }
            var already = sameCurrency ? others.Sum(r => r.Amount) : others.Sum(r => r.Amount * r.ExchangeRate);
            throw Refuse(already > 0m
                ? $"Refunds of this purchase would total {refunded:0.##}, more than the {paid:0.##} paid ({already:0.##} already refunded)."
                : $"A refund of {refunded:0.##} is more than the {paid:0.##} paid for this purchase.");
        }

        return original;
    }

    /// <summary>
    /// Every refund linked to <paramref name="originalId"/>, whoever can see it. A refund in another
    /// login's private account still counts against the purchase (W13), so this reads past the
    /// query filters; only amounts, dates and whether the caller can see each one leave here.
    /// </summary>
    public static async Task<List<RefundRecord>> AllRefundsAsync(
        IApplicationDbContext db, Guid originalId, CancellationToken cancellationToken)
    {
        var all = await db.Transactions.IgnoreQueryFilters()
            .Where(r => r.RefundOfTransactionId == originalId)
            .Select(r => new { r.Id, r.Amount, r.Currency, r.ExchangeRate, r.Date })
            .ToListAsync(cancellationToken);
        var ids = all.Select(r => r.Id).ToList();
        var visible = (await db.Transactions.Where(r => ids.Contains(r.Id)).Select(r => r.Id).ToListAsync(cancellationToken))
            .ToHashSet();
        return all.Select(r => new RefundRecord(r.Id, r.Amount, r.Currency, r.ExchangeRate, r.Date, !visible.Contains(r.Id)))
            .ToList();
    }

    /// <summary>A refund of a purchase as the refund checks need it; <c>Hidden</c> when the caller can't see it.</summary>
    public readonly record struct RefundRecord(
        Guid Id, decimal Amount, Domain.ValueObjects.CurrencyCode Currency, decimal ExchangeRate, DateOnly Date, bool Hidden)
    {
        public RefundLeg Leg => new(Amount, Currency, ExchangeRate);
    }

    /// <summary>One refund's money as recorded: its amount, currency and the rate that converts it to the base currency.</summary>
    public readonly record struct RefundLeg(decimal Amount, Domain.ValueObjects.CurrencyCode Currency, decimal ExchangeRate);

    /// <summary>
    /// What a purchase of <paramref name="purchaseAmount"/> in <paramref name="purchaseCurrency"/>
    /// paid and what <paramref name="refunds"/> gave back, on one scale (rule 39): when every
    /// refund is in the purchase's currency the amounts as recorded are compared, otherwise the
    /// base-currency values (each amount × its own rate; O5: the user's converted figure). The
    /// one comparison behind linking a refund and editing the purchase it refunds.
    /// <c>SameCurrency</c> says which scale the two figures are on.
    /// </summary>
    public static (decimal Paid, decimal Refunded, bool SameCurrency) Totals(
        Domain.ValueObjects.CurrencyCode purchaseCurrency, decimal purchaseAmount, decimal purchaseExchangeRate,
        IReadOnlyCollection<RefundLeg> refunds)
    {
        var sameCurrency = refunds.All(r => r.Currency == purchaseCurrency);
        return sameCurrency
            ? (purchaseAmount, refunds.Sum(r => r.Amount), true)
            : (purchaseAmount * purchaseExchangeRate, refunds.Sum(r => r.Amount * r.ExchangeRate), false);
    }

    /// <summary>
    /// The line a refund lands on when the user picks none: the line in the refund's own month
    /// that continues the original's line — the same jar, else the same category (kind and name)
    /// and line name — so the refund reduces net spending in that category in the month it is
    /// received (rules 38/39). Null when the original is unassigned, the refund's month has no
    /// such line, or the line is a jar whose account the refund did not reach (rule 79); the
    /// refund is then left uncategorised for the user to place.
    /// </summary>
    public static async Task<BudgetItem?> DefaultLineAsync(
        IApplicationDbContext db,
        string userId,
        Transaction original,
        DateOnly refundDate,
        Guid? refundAccountId,
        CancellationToken cancellationToken)
    {
        if (original.BudgetItemId is not Guid originalLineId)
        {
            return null;
        }

        var originalLine = await db.BudgetItems
            .AsNoTracking()
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .FirstOrDefaultAsync(i => i.Id == originalLineId, cancellationToken);
        if (originalLine is null)
        {
            return null;
        }

        var month = originalLine.BudgetCategory.BudgetMonth;
        BudgetItem? line;
        if (month.Year == refundDate.Year && month.Month == refundDate.Month)
        {
            line = await LoadLineAsync(db, i => i.Id == originalLineId, cancellationToken);
        }
        else if (originalLine.SavingsId is Guid savingsId)
        {
            line = await LoadLineAsync(db,
                i => i.SavingsId == savingsId
                     && i.BudgetCategory.BudgetMonth.OwnerId == userId
                     && i.BudgetCategory.BudgetMonth.Year == refundDate.Year
                     && i.BudgetCategory.BudgetMonth.Month == refundDate.Month,
                cancellationToken);
        }
        else
        {
            var kind = originalLine.BudgetCategory.Kind;
            var categoryName = originalLine.BudgetCategory.Name;
            var lineName = originalLine.Name;
            line = await LoadLineAsync(db,
                i => i.BudgetCategory.BudgetMonth.OwnerId == userId
                     && i.BudgetCategory.BudgetMonth.Year == refundDate.Year
                     && i.BudgetCategory.BudgetMonth.Month == refundDate.Month
                     && i.BudgetCategory.Kind == kind
                     && i.BudgetCategory.Name == categoryName
                     && i.Name == lineName,
                cancellationToken);
        }

        if (line is null || line.BudgetCategory.Kind == CategoryKind.Income)
        {
            return null;
        }
        // A jar line's money lives in the jar's account (rule 79): a refund that reached another
        // account, or none, cannot land on it by default.
        if (line.SavingsId is not null && line.Jar is not null && line.Jar.FundingAccountId != refundAccountId)
        {
            return null;
        }
        return line;
    }

    private static Task<BudgetItem?> LoadLineAsync(
        IApplicationDbContext db,
        System.Linq.Expressions.Expression<Func<BudgetItem, bool>> predicate,
        CancellationToken cancellationToken) =>
        db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Include(i => i.Jar)
                .ThenInclude(j => j!.FundingAccount)
            .OrderBy(i => i.DisplayOrder)
            .FirstOrDefaultAsync(predicate, cancellationToken);

    private static ValidationException Refuse(string message) =>
        new(new Dictionary<string, string[]> { [Key] = new[] { message } });
}
