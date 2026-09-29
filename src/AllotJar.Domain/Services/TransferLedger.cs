using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Services;

/// <summary>
/// Bank posting dates explicitly supplied for one identified transfer. A null receipt
/// means receipt has not been confirmed. A receipt with no departure is held for review
/// and cannot affect either account until its departure details are supplied. A return
/// date means the source bank credited the money back: it never reaches the destination.
/// </summary>
public sealed record TransferPostingDates(DateOnly? DepartedOn, DateOnly? ReceivedOn, DateOnly? ReturnedOn = null)
{
    /// <summary>The persisted legs of <paramref name="transfer"/>.</summary>
    public static TransferPostingDates Of(Transaction transfer) =>
        new(transfer.DepartedOn, transfer.ReceivedOn, transfer.ReturnedOn);

    internal void Validate()
    {
        if (DepartedOn is null && ReceivedOn is null)
            throw new InvalidOperationException("A transfer requires at least one confirmed bank posting date.");
        if (ReturnedOn is DateOnly returned && (DepartedOn is not DateOnly departed || ReceivedOn is not null || returned < departed))
            throw new InvalidOperationException("Only a transfer that departed and was never received can be returned, on or after its departure.");
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
        var returned = dates.ReturnedOn is DateOnly back && back <= asOf ? transfer.Amount : 0m;
        return new(transfer.Id, transfer.Currency, asOf, debited, credited) { ReturnedAmount = returned };
    }

    /// <summary>
    /// The identity of a returned transfer's second movement on its source account: the credit
    /// back. Both legs share the transfer, so the return gets its own derived key in the account
    /// ledger (and its jar attribution mirrors the departure's; it is never stored).
    /// </summary>
    public static Guid ReturnLegId(Guid transferId)
    {
        var bytes = transferId.ToByteArray();
        for (var i = 0; i < bytes.Length; i++)
            bytes[i] ^= ReturnLegMask[i];
        return new Guid(bytes);
    }

    private static readonly byte[] ReturnLegMask =
        { 0x5a, 0x3c, 0x96, 0xe1, 0x0f, 0x7b, 0x42, 0xd8, 0xa5, 0x19, 0xc3, 0x6e, 0xb7, 0x28, 0x84, 0xf0 };

    /// <summary>
    /// The persisted bank legs of every transfer in <paramref name="transactions"/>, keyed by
    /// transaction id, in the shape the ledger calculations consume. Non-transfers are skipped.
    /// </summary>
    public static Dictionary<Guid, TransferPostingDates> PostingDates(IEnumerable<Transaction> transactions) =>
        transactions
            .Where(t => t.Type == TransactionType.Transfer)
            .ToDictionary(t => t.Id, TransferPostingDates.Of);

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
/// UnsettledAmount is positive for money in transit after departure and before receipt (or return).
/// It is signed to preserve reconciliation if supplied bank dates put receipt first;
/// that case must not be silently relabelled as new income or given an invented debit date.
/// A receipt with an unknown departure is separately exposed for review and has no
/// posted or in-transit amount. Its known bank date and amount are preserved.
/// </summary>
public sealed record TransferLedgerPosition(
    Guid TransferId, CurrencyCode Currency, DateOnly AsOf, decimal DebitedAmount, decimal CreditedAmount)
{
    /// <summary>What the source bank has credited back by the as-of date (a returned transfer).</summary>
    public decimal ReturnedAmount { get; init; }
    public decimal UnsettledAmount => DebitedAmount - CreditedAmount - ReturnedAmount;
    public PendingTransferReceipt? PendingReceipt { get; init; }
    public bool RequiresReview => PendingReceipt is not null;
}
