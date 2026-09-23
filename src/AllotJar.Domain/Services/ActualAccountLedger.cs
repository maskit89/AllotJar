using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>
/// Actual money in one account, in that account's currency. OpeningDate is supplied
/// explicitly until dated openings are persisted; never infer it from transactions.
/// Calendar cutoffs include the whole as-of date. Budget plans and FX rates play no part.
/// </summary>
public static class ActualAccountLedger
{
    public static AccountLedgerBalance Calculate(
        Account account, DateOnly openingDate, DateOnly asOf,
        IReadOnlyCollection<Transaction> transactions)
    {
        if (asOf < openingDate) return new(asOf, null);

        var movements = Movements(account, openingDate, asOf, transactions);
        return new(asOf, account.OpeningBalance + movements.Values.Sum());
    }

    internal static Dictionary<Guid, decimal> Movements(
        Account account, DateOnly openingDate, DateOnly asOf,
        IReadOnlyCollection<Transaction> transactions)
    {
        var result = new Dictionary<Guid, decimal>();
        foreach (var transaction in transactions.Where(t =>
                     t.OwnerId == account.OwnerId && t.Date >= openingDate && t.Date <= asOf &&
                     (t.AccountId == account.Id ||
                      (t.Type == TransactionType.Transfer && t.TransferAccountId == account.Id))))
        {
            if (transaction.Currency != account.Currency)
                throw new InvalidOperationException("Account movements require an authoritative amount in the account currency.");
            if (transaction.Amount <= 0)
                throw new InvalidOperationException("Transaction amounts must be positive magnitudes.");
            if (transaction.Type == TransactionType.Transfer &&
                (transaction.AccountId is null || transaction.TransferAccountId is null ||
                 transaction.AccountId == transaction.TransferAccountId))
                throw new InvalidOperationException("A transfer requires two distinct accounts.");

            var amount = transaction.Type switch
            {
                TransactionType.Income => transaction.Amount,
                TransactionType.Expense => -transaction.Amount,
                TransactionType.Transfer => transaction.AccountId == account.Id
                    ? -transaction.Amount : transaction.Amount,
                _ => throw new InvalidOperationException("Unknown transaction direction."),
            };
            if (!result.TryAdd(transaction.Id, amount))
                throw new InvalidOperationException("The same transaction cannot be counted twice.");
        }
        return result;
    }
}

public sealed record AccountLedgerBalance(DateOnly AsOf, decimal? Balance)
{
    public bool IsAvailable => Balance.HasValue;
}
