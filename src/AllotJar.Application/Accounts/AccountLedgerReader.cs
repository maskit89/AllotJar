using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Accounts;

/// <summary>
/// One account's actual-money position as of a date, in the account's own currency, read
/// through <see cref="ActualAccountLedger"/>: the opening balance at the start of the opening
/// date plus every income/expense leg and every confirmed transfer leg posted up to and
/// including the as-of date. Nothing here is a budget plan or an exchange-rate estimate.
/// </summary>
/// <param name="Balance">
/// Null when unavailable: the account has no opening date on record, or the as-of date is
/// earlier than the opening date (rule 67). Never zero or reconstructed.
/// </param>
/// <param name="InTransitOut">
/// Transfers that have left this account (departure posted on or before as-of) whose receipt
/// is not yet confirmed. Already excluded from <see cref="Balance"/>; shown so the money is
/// visibly in transit rather than vanished (rule 69/71).
/// </param>
/// <param name="InTransitIn">
/// Transfers that have left another account for this one and are not yet received. Not part of
/// <see cref="Balance"/> — the money belongs to neither account until the destination posts it.
/// </param>
/// <param name="PendingReceipts">
/// Receipts identified as own-account transfers whose departure is unknown (rule 72). Held for
/// review on both accounts with no posted effect; the bank's amount and date are preserved.
/// </param>
public sealed record AccountLedgerView(
    DateOnly AsOf,
    decimal? Balance,
    bool OpeningDateMissing,
    decimal InTransitOut,
    decimal InTransitIn,
    IReadOnlyList<PendingTransferReceipt> PendingReceipts)
{
    public bool IsAvailable => Balance.HasValue;
    public decimal PendingReceiptTotal => PendingReceipts.Sum(p => p.Amount);
    public bool RequiresReview => PendingReceipts.Count > 0;
}

/// <summary>
/// The single read path for account money. Every account, reconciliation and allocation
/// reader goes through here so no caller re-derives a balance from raw transaction sums.
/// </summary>
public static class AccountLedgerReader
{
    public static async Task<Dictionary<Guid, AccountLedgerView>> ReadAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Account> accounts,
        DateOnly asOf,
        CancellationToken cancellationToken,
        Func<Transaction, bool>? exclude = null)
    {
        var views = new Dictionary<Guid, AccountLedgerView>();
        if (accounts.Count == 0)
        {
            return views;
        }

        var accountIds = accounts.Select(a => a.Id).ToList();

        // Every leg that touches one of these accounts: its own income/expense/outgoing legs plus
        // transfers arriving into it. Loaded once for the whole set; the ledger filters per account.
        var transactions = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == ownerId
                        && ((t.AccountId != null && accountIds.Contains(t.AccountId.Value))
                            || (t.Type == TransactionType.Transfer
                                && t.TransferAccountId != null
                                && accountIds.Contains(t.TransferAccountId.Value))))
            .ToListAsync(cancellationToken);
        if (exclude is not null)
        {
            transactions = transactions.Where(t => !exclude(t)).ToList();
        }

        // A transfer with a leg pointing at a deleted account cannot be read as a movement
        // between two accounts. DeleteAccount refuses to leave such rows behind, so this only
        // guards rows that predate that rule; they are ignored rather than half-applied.
        var readable = transactions
            .Where(t => t.Type != TransactionType.Transfer
                        || (t.AccountId is not null && t.TransferAccountId is not null))
            .ToList();
        var postingDates = TransferLedger.PostingDates(readable);

        foreach (var account in accounts)
        {
            var (inTransitOut, inTransitIn) = TransitFor(account, readable, asOf);

            if (account.OpeningDate is not DateOnly openingDate)
            {
                // No date, no balance — and no pending-receipt evidence either, because the
                // ledger cannot place any movement relative to an unknown opening.
                views[account.Id] = new AccountLedgerView(asOf, null, true, inTransitOut, inTransitIn, []);
                continue;
            }

            var balance = ActualAccountLedger.Calculate(account, openingDate, asOf, readable, postingDates);
            views[account.Id] = new AccountLedgerView(
                asOf, balance.Balance, false, inTransitOut, inTransitIn, balance.PendingTransferReceipts);
        }

        return views;
    }

    /// <summary>Money that has departed but not arrived, from and to this account, as of the date.</summary>
    private static (decimal Out, decimal In) TransitFor(
        Account account, IReadOnlyList<Transaction> transactions, DateOnly asOf)
    {
        decimal transitOut = 0m, transitIn = 0m;
        foreach (var transfer in transactions.Where(t => t.Type == TransactionType.Transfer && t.DepartedOn is not null))
        {
            var position = TransferLedger.Calculate(transfer, TransferPostingDates.Of(transfer), asOf);
            if (position.UnsettledAmount <= 0m)
            {
                continue;
            }
            if (transfer.AccountId == account.Id) transitOut += position.UnsettledAmount;
            if (transfer.TransferAccountId == account.Id) transitIn += position.UnsettledAmount;
        }
        return (transitOut, transitIn);
    }
}
