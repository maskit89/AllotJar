using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>
/// Actual money in one account, in that account's currency. OpeningDate is supplied
/// explicitly until dated openings are persisted; never infer it from transactions.
/// Calendar cutoffs include the whole as-of date. Budget plans and FX rates play no part.
/// Transfers require separately supplied bank posting dates; Transaction.Date is not
/// a fallback. Receipts awaiting departure details are visible for review but do not
/// contribute to either account's posted balance.
/// </summary>
public static class ActualAccountLedger
{
    public static AccountLedgerBalance Calculate(
        Account account, DateOnly openingDate, DateOnly asOf,
        IReadOnlyCollection<Transaction> transactions,
        IReadOnlyDictionary<Guid, TransferPostingDates>? transferDates = null)
    {
        if (asOf < openingDate) return new(asOf, null);

        var entries = Entries(account, openingDate, asOf, transactions, transferDates);
        return new(asOf, account.OpeningBalance + entries.Movements.Values.Sum(m => m.Amount))
        {
            PendingTransferReceipts = entries.PendingReceipts,
        };
    }

    public static AccountLedgerEntries Entries(
        Account account, DateOnly openingDate, DateOnly asOf,
        IReadOnlyCollection<Transaction> transactions,
        IReadOnlyDictionary<Guid, TransferPostingDates>? transferDates)
    {
        var result = new Dictionary<Guid, AccountLedgerMovement>();
        var pendingReceipts = new List<PendingTransferReceipt>();
        var pendingIds = new HashSet<Guid>();
        foreach (var transaction in transactions.Where(t =>
                     t.OwnerId == account.OwnerId &&
                     (t.AccountId == account.Id ||
                      (t.Type == TransactionType.Transfer && t.TransferAccountId == account.Id))))
        {
            DateOnly? date = transaction.Date;
            if (transaction.Type == TransactionType.Transfer)
            {
                TransferLedger.Validate(transaction);
                if (transferDates is null || !transferDates.TryGetValue(transaction.Id, out var dates))
                    throw new InvalidOperationException("Transfers require explicit bank posting dates; a receipt date must not be inferred.");
                dates.Validate();
                if (dates.DepartedOn is null)
                {
                    // Both account views must disclose the incomplete transfer. The receipt
                    // is evidence, not a credit, debit or inferred in-transit amount.
                    var pending = TransferLedger.Calculate(transaction, dates, asOf).PendingReceipt;
                    if (pending is not null)
                    {
                        if (transaction.Currency != account.Currency)
                            throw new InvalidOperationException("Account movements require an authoritative amount in the account currency.");
                        if (!pendingIds.Add(transaction.Id))
                            throw new InvalidOperationException("The same pending transfer receipt cannot be counted twice.");
                        pendingReceipts.Add(pending);
                    }
                    continue;
                }
                date = transaction.AccountId == account.Id ? dates.DepartedOn : dates.ReceivedOn;
            }
            // A missing receipt has no destination movement. The account's opening
            // cutoff applies to its own leg, not the other bank's posting date.
            if (date is not DateOnly posted || posted < openingDate || posted > asOf) continue;

            if (transaction.Currency != account.Currency)
                throw new InvalidOperationException("Account movements require an authoritative amount in the account currency.");
            if (transaction.Amount <= 0)
                throw new InvalidOperationException("Transaction amounts must be positive magnitudes.");
            var amount = transaction.Type switch
            {
                TransactionType.Income => transaction.Amount,
                TransactionType.Expense => -transaction.Amount,
                TransactionType.Transfer => transaction.AccountId == account.Id
                    ? -transaction.Amount : transaction.Amount,
                _ => throw new InvalidOperationException("Unknown transaction direction."),
            };
            if (!result.TryAdd(transaction.Id, new(posted, amount)))
                throw new InvalidOperationException("The same transaction cannot be counted twice.");
        }
        return new(result, pendingReceipts.AsReadOnly());
    }
}

public sealed record AccountLedgerMovement(DateOnly Date, decimal Amount);
public sealed record AccountLedgerEntries(
    Dictionary<Guid, AccountLedgerMovement> Movements,
    IReadOnlyList<PendingTransferReceipt> PendingReceipts);

public sealed record AccountLedgerBalance(DateOnly AsOf, decimal? Balance)
{
    public bool IsAvailable => Balance.HasValue;
    public IReadOnlyList<PendingTransferReceipt> PendingTransferReceipts { get; init; } = [];
    public bool RequiresReview => PendingTransferReceipts.Count > 0;
}
