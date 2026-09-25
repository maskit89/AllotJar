using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Services;

/// <summary>
/// Bank posting dates explicitly supplied for one identified transfer. A null receipt
/// means receipt has not been confirmed. A receipt with no departure is held for review
/// and cannot affect either account until its departure details are supplied.
/// These inputs are not yet persisted by the existing transaction endpoints.
/// </summary>
public sealed record TransferPostingDates(DateOnly? DepartedOn, DateOnly? ReceivedOn)
{
    internal void Validate()
    {
        if (DepartedOn is null && ReceivedOn is null)
            throw new InvalidOperationException("A transfer requires at least one confirmed bank posting date.");
    }
}

/// <summary>Known bank evidence held for review, not posted or spendable money.</summary>
public sealed record PendingTransferReceipt(
    Guid TransferId, CurrencyCode Currency, DateOnly ReceivedOn, decimal Amount);

/// <summary>
/// Read calculation for an identified transfer. Callers supply
/// authorised, confirmed bank/user data. This does not initiate a bank transfer, infer
/// missing details, match statements or persist a receipt confirmation.
/// </summary>
public static class TransferLedger
{
    public static TransferLedgerPosition Calculate(
        Transaction transfer, TransferPostingDates dates, DateOnly asOf)
    {
        Validate(transfer);
        dates.Validate();
        if (dates.DepartedOn is null)
        {
            var pending = dates.ReceivedOn is DateOnly receivedOn && receivedOn <= asOf
                ? new PendingTransferReceipt(transfer.Id, transfer.Currency, receivedOn, transfer.Amount)
                : null;
            return new(transfer.Id, transfer.Currency, asOf, 0m, 0m) { PendingReceipt = pending };
        }
        var debited = dates.DepartedOn.Value <= asOf ? transfer.Amount : 0m;
        var credited = dates.ReceivedOn is DateOnly received && received <= asOf ? transfer.Amount : 0m;
        return new(transfer.Id, transfer.Currency, asOf, debited, credited);
    }

    /// <summary>
    /// The persisted bank legs of every transfer in <paramref name="transactions"/>, keyed by
    /// transaction id, in the shape the ledger calculations consume. Non-transfers are skipped.
    /// </summary>
    public static Dictionary<Guid, TransferPostingDates> PostingDates(IEnumerable<Transaction> transactions) =>
        transactions
            .Where(t => t.Type == TransactionType.Transfer)
            .ToDictionary(t => t.Id, t => new TransferPostingDates(t.DepartedOn, t.ReceivedOn));

    internal static void Validate(Transaction transfer)
    {
        if (transfer.Type != TransactionType.Transfer)
            throw new InvalidOperationException("A transfer ledger position requires a transfer.");
        if (transfer.AccountId is null || transfer.TransferAccountId is null ||
            transfer.AccountId == transfer.TransferAccountId)
            throw new InvalidOperationException("A transfer requires two distinct accounts.");
        if (transfer.Amount <= 0m)
            throw new InvalidOperationException("Transaction amounts must be positive magnitudes.");
    }
}

/// <summary>
/// UnsettledAmount is positive for money in transit after departure and before receipt.
/// It is signed to preserve reconciliation if supplied bank dates put receipt first;
/// that case must not be silently relabelled as new income or given an invented debit date.
/// A receipt with an unknown departure is separately exposed for review and has no
/// posted or in-transit amount. Its known bank date and amount are preserved.
/// </summary>
public sealed record TransferLedgerPosition(
    Guid TransferId, CurrencyCode Currency, DateOnly AsOf, decimal DebitedAmount, decimal CreditedAmount)
{
    public decimal UnsettledAmount => DebitedAmount - CreditedAmount;
    public PendingTransferReceipt? PendingReceipt { get; init; }
    public bool RequiresReview => PendingReceipt is not null;
}
