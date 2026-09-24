using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Services;

/// <summary>
/// Bank posting dates explicitly supplied for one transfer. A null receipt means
/// receipt has not been confirmed; it must never fall back to the departure date.
/// These inputs are not yet persisted by the existing transaction endpoints.
/// </summary>
public sealed record TransferPostingDates(DateOnly DepartedOn, DateOnly? ReceivedOn);

/// <summary>
/// Read calculation for a transfer whose departure details are known. Callers supply
/// authorised, confirmed bank/user data. This does not initiate a bank transfer, infer
/// missing details, match statements or persist a receipt confirmation.
/// </summary>
public static class TransferLedger
{
    public static TransferLedgerPosition Calculate(
        Transaction transfer, TransferPostingDates dates, DateOnly asOf)
    {
        Validate(transfer);
        var debited = dates.DepartedOn <= asOf ? transfer.Amount : 0m;
        var credited = dates.ReceivedOn is DateOnly received && received <= asOf ? transfer.Amount : 0m;
        return new(transfer.Id, transfer.Currency, asOf, debited, credited);
    }

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
/// This arithmetic does not decide the unresolved receipt-first import workflow.
/// </summary>
public sealed record TransferLedgerPosition(
    Guid TransferId, CurrencyCode Currency, DateOnly AsOf, decimal DebitedAmount, decimal CreditedAmount)
{
    public decimal UnsettledAmount => DebitedAmount - CreditedAmount;
}
