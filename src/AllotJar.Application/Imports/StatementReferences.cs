using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Imports;

/// <summary>What a statement account already recorded under one bank reference: the entry's date, amount and direction on that account.</summary>
/// <paramref name="BankEntry"/> is what the bank printed, when the user has since changed the row
/// (<see cref="Transaction.BankEntry"/>): the statement's entry is then recognised by it.
public sealed record KnownEntry(DateOnly Date, decimal Amount, bool IsCredit, string? BankEntry = null)
{
    public bool Matches(DateOnly date, decimal amount, bool isCredit) =>
        BankEntry is not null
            ? BankEntry == StatementReferences.Entry(date, amount, isCredit)
            : Date == date && Amount == amount && IsCredit == isCredit;
}

/// <summary>
/// How a statement row's reference stands against what the account already knows. A
/// <see cref="Duplicate"/> is the entry already imported (same reference, date, amount and
/// direction) and is skipped. A reference already used for an entry with different details
/// (<see cref="ReusedFrom"/>, O1 answer 2: a bank reusing a reference, e.g. a standing order) is
/// shown for the user to decide, under a derived <see cref="Reference"/> unique to those details
/// so importing it, and re-importing it later, stay idempotent.
/// </summary>
public readonly record struct ResolvedReference(string? Reference, bool Duplicate, KnownEntry? ReusedFrom);

/// <summary>The bank references a statement account already knows, with the entry each one recorded.</summary>
public sealed class KnownReferences
{
    private readonly Dictionary<string, KnownEntry> _entries;

    internal KnownReferences(Dictionary<string, KnownEntry> entries) => _entries = entries;

    public bool Contains(string reference) => _entries.ContainsKey(reference);

    public ResolvedReference Resolve(string? reference, DateOnly date, decimal amount, bool isCredit)
    {
        if (string.IsNullOrEmpty(reference))
        {
            return new(null, false, null);
        }
        if (!_entries.TryGetValue(reference, out var known))
        {
            return new(reference, false, null);
        }
        if (known.Matches(date, amount, isCredit))
        {
            return new(reference, true, null);
        }
        var derived = StatementReferences.Derive(reference, date, amount, isCredit);
        return _entries.ContainsKey(derived) ? new(derived, true, null) : new(derived, false, known);
    }

    /// <summary>Records <paramref name="reference"/> as taken by this row; false when it already was.</summary>
    public bool Add(string reference, DateOnly date, decimal amount, bool isCredit) =>
        _entries.TryAdd(reference, new KnownEntry(date, amount, isCredit));

    public void Remove(string? reference)
    {
        if (reference is not null)
        {
            _entries.Remove(reference);
        }
    }
}

/// <summary>
/// The one definition of "this statement account already knows this bank reference", shared
/// by preview and commit so the stages can never disagree about what is a duplicate, and of
/// which recorded transfers a statement row could confirm. A reference belongs to the account
/// whose statement carried it: an income/expense row, a transfer's source leg and a returned
/// transfer's credit back keep it on <see cref="Transaction.AccountId"/>
/// (<see cref="Transaction.BankReference"/>, <see cref="Transaction.ReturnBankReference"/>); a
/// transfer's destination leg keeps it in <see cref="Transaction.ReceiptBankReference"/> on
/// <see cref="Transaction.TransferAccountId"/> (rule 51). Rows recorded before receipt
/// references existed stored an inbound transfer's reference on the source leg (the migration
/// marked them received on their date), so a transfer whose receipt is recorded without a
/// reference of its own is still honoured on the destination side by its source reference. A
/// transfer whose receipt is still unknown carries nothing for the destination: its source
/// reference is the other bank's, and the receipt row that shares it is the very row the
/// destination statement has yet to confirm. Case-insensitive to agree with the unique indexes'
/// CI collation.
/// </summary>
public static class StatementReferences
{
    /// <summary>The longest reference the columns hold (TransactionConfiguration).</summary>
    private const int MaxReferenceLength = 140;

    public static async Task<KnownReferences> KnownAsync(
        IApplicationDbContext db, string ownerId, Guid? accountId, CancellationToken cancellationToken)
    {
        var rows = await db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == ownerId
                        && ((t.AccountId == accountId
                             && (t.BankReference != null || t.ReturnBankReference != null))
                            || (accountId != null && t.Type == TransactionType.Transfer
                                && t.TransferAccountId == accountId
                                && (t.ReceiptBankReference != null
                                    || (t.ReceivedOn != null && t.BankReference != null)))))
            .Select(t => new
            {
                t.Type, t.AccountId, t.Amount, t.Date, t.DepartedOn, t.ReceivedOn, t.ReturnedOn,
                t.BankReference, t.ReceiptBankReference, t.ReturnBankReference, t.BankEntry,
                Fee = t.Fee != null ? t.Fee.Amount : 0m,
            })
            .ToListAsync(cancellationToken);

        var entries = new Dictionary<string, KnownEntry>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in rows)
        {
            if (t.AccountId == accountId)
            {
                if (t.BankReference is not null)
                {
                    entries.TryAdd(t.BankReference, t.Type switch
                    {
                        TransactionType.Income => new KnownEntry(t.Date, t.Amount, true, t.BankEntry),
                        TransactionType.Transfer => new KnownEntry(t.DepartedOn ?? t.Date, t.Amount + t.Fee, false, t.BankEntry),
                        _ => new KnownEntry(t.Date, t.Amount, false, t.BankEntry),
                    });
                }
                if (t.ReturnBankReference is not null)
                {
                    entries.TryAdd(t.ReturnBankReference, new KnownEntry(t.ReturnedOn ?? t.Date, t.Amount, true));
                }
            }
            else
            {
                entries.TryAdd(t.ReceiptBankReference ?? t.BankReference!, new KnownEntry(t.ReceivedOn ?? t.Date, t.Amount, true));
            }
        }
        return new KnownReferences(entries);
    }

    /// <summary>One statement entry's details as <see cref="Transaction.BankEntry"/> keeps them.</summary>
    public static string Entry(DateOnly date, decimal amount, bool isCredit) =>
        $"{date:yyyy-MM-dd}|{amount.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture)}|{(isCredit ? 'C' : 'D')}";

    /// <summary>
    /// The reference a row with a reused bank reference is stored under: the bank's reference
    /// plus a short hash of the row's own date, amount and direction, within the column's length.
    /// </summary>
    public static string Derive(string reference, DateOnly date, decimal amount, bool isCredit)
    {
        var signature = $"{date:yyyy-MM-dd}|{amount:0.####}|{(isCredit ? 'C' : 'D')}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature)), 0, 4).ToLowerInvariant();
        var suffix = "~" + hash;
        var head = reference.Length + suffix.Length <= MaxReferenceLength
            ? reference
            : reference[..(MaxReferenceLength - suffix.Length)];
        return head + suffix;
    }

    /// <summary>
    /// Recorded transfers touching <paramref name="accountId"/> that a statement row on it could
    /// confirm a leg of, with their fee row. Every one is considered regardless of date (O1
    /// answer 1): the user sees them all, nearest first, and chooses.
    /// </summary>
    public static async Task<List<Transaction>> TransfersAsync(
        IApplicationDbContext db, string ownerId, Guid accountId, CancellationToken cancellationToken) =>
        await db.Transactions
            .AsNoTracking()
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Include(t => t.Fee)
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Transfer
                        && t.AccountId != null && t.TransferAccountId != null
                        && ((t.TransferAccountId == accountId
                             && (t.ReceivedOn == null || t.ReceiptBankReference == null) && t.ReturnedOn == null)
                            || (t.AccountId == accountId
                                && (t.DepartedOn == null || t.BankReference == null
                                    || ((t.ReceivedOn == null || t.ReceiptBankReference == null)
                                        && t.ReturnBankReference == null)))))
            .ToListAsync(cancellationToken);

    /// <summary>
    /// The largest fee a statement row can propose, against what arrives: a larger difference is
    /// another payment, not this transfer (a 1,100 rent debit is not last month's 100 transfer
    /// with a fee of 1,000).
    /// </summary>
    public const decimal MaxProposedFeeShare = 0.10m;

    /// <summary>
    /// How a statement row on <paramref name="accountId"/> can confirm a leg of
    /// <paramref name="transfer"/>, or null when it can't. A debit confirms the departure: the
    /// source was debited the transfer's amount plus its fee, so a larger debit means a fee of the
    /// difference that the user must accept (O1 answer 5). A credit confirms the receipt: a
    /// smaller credit means the difference was a fee taken on the way, when the departure is
    /// known. A fee is proposed only while it is small against what arrives
    /// (<see cref="MaxProposedFeeShare"/>). A credit on the source of a transfer that departed and
    /// whose receipt no statement confirmed confirms the money coming back (O1 answer 4). A leg
    /// recorded in the app without a statement reference can be confirmed too: the bank's date
    /// replaces the recorded one (rule 69) and no money moves again (rules 8/71). A leg a
    /// statement already confirmed is never offered. The transfer's <see cref="Transaction.Account"/>
    /// and <see cref="Transaction.TransferAccount"/> must be loaded through the privacy filter: a
    /// side private to another login reads "Private account", and nothing that would change that
    /// side (a fee taken from it, a return that undoes its receipt) is offered (P57).
    /// </summary>
    public static TransferMatchCandidate? CandidateFor(
        Transaction transfer, Guid accountId, bool isCredit, decimal amount, string currency, DateOnly date, string? reference)
    {
        if (!string.Equals(transfer.Currency.Value, currency, StringComparison.OrdinalIgnoreCase)
            || transfer.AccountId is null || transfer.TransferAccountId is null)
        {
            return null;
        }
        var fee = transfer.Fee?.Amount ?? 0m;
        var sourceHidden = transfer.Account is null;
        var destinationHidden = transfer.TransferAccount is null;
        bool SameAs(string? other) =>
            reference is not null && other is not null && string.Equals(reference, other, StringComparison.OrdinalIgnoreCase);
        bool Proposable(decimal proposed, decimal arriving) => proposed <= arriving * MaxProposedFeeShare;

        if (!isCredit)
        {
            if (transfer.AccountId != accountId || !IsOpenFor(transfer, accountId, false)
                || (transfer.ReturnedOn is DateOnly back && date > back))
            {
                return null;
            }
            if (transfer.Amount + fee == amount)
            {
                return Candidate(transfer, false, TransferMatchKinds.Match, null, transfer.DepartedOn, SameAs(transfer.ReceiptBankReference));
            }
            return transfer.Amount < amount && Proposable(amount - transfer.Amount, transfer.Amount)
                ? Candidate(transfer, false, TransferMatchKinds.Match, amount - transfer.Amount, transfer.DepartedOn, SameAs(transfer.ReceiptBankReference))
                : null;
        }

        if (transfer.TransferAccountId == accountId && IsOpenFor(transfer, accountId, true))
        {
            if (transfer.Amount == amount)
            {
                return Candidate(transfer, true, TransferMatchKinds.Match, null, transfer.ReceivedOn, SameAs(transfer.BankReference));
            }
            // The fee is taken from the source: not offered when that side is private to another login.
            var newFee = transfer.Amount + fee - amount;
            return transfer.Amount > amount && transfer.DepartedOn is not null && !sourceHidden && Proposable(newFee, amount)
                ? Candidate(transfer, true, TransferMatchKinds.Match, newFee, transfer.ReceivedOn, SameAs(transfer.BankReference))
                : null;
        }
        if (transfer.AccountId == accountId && IsReturnableTo(transfer, accountId) && !destinationHidden
            && transfer.Amount == amount && date >= transfer.DepartedOn!.Value)
        {
            return Candidate(transfer, false, TransferMatchKinds.Return, null, transfer.ReturnedOn, false);
        }
        return null;
    }

    /// <summary>
    /// Whether <paramref name="transfer"/>'s leg that a row on <paramref name="accountId"/> would
    /// confirm is still open to a statement: a credit confirms receipt into the account, a debit
    /// departure from it. Open means unknown, or recorded in the app without that bank's reference.
    /// A returned transfer has no receipt to confirm.
    /// </summary>
    public static bool IsOpenFor(Transaction transfer, Guid accountId, bool isCredit) =>
        isCredit
            ? transfer.TransferAccountId == accountId && transfer.ReturnedOn is null
              && (transfer.ReceivedOn is null || transfer.ReceiptBankReference is null)
            : transfer.AccountId == accountId && (transfer.DepartedOn is null || transfer.BankReference is null);

    /// <summary>
    /// Whether a credit on <paramref name="accountId"/> can confirm <paramref name="transfer"/>
    /// coming back: it left this account, no statement confirmed its receipt (an arrival the app
    /// only guessed, as "Move money" does, is undone by the return) and none confirmed a return yet.
    /// </summary>
    public static bool IsReturnableTo(Transaction transfer, Guid accountId) =>
        transfer.AccountId == accountId && transfer.DepartedOn is not null
        && (transfer.ReceivedOn is null || transfer.ReceiptBankReference is null)
        && transfer.ReturnBankReference is null;

    private static TransferMatchCandidate Candidate(
        Transaction transfer, bool isCredit, string kind, decimal? fee, DateOnly? recorded, bool sameReference)
    {
        // The other side of the transfer: its source for a receipt, its destination otherwise.
        var (counterpartyId, counterparty) = isCredit && kind == TransferMatchKinds.Match
            ? (transfer.AccountId!.Value, transfer.Account)
            : (transfer.TransferAccountId!.Value, transfer.TransferAccount);
        return new(transfer.Id, counterparty is null ? null : counterpartyId,
            counterparty?.Name ?? TransactionMapping.PrivateAccountName, transfer.Amount, transfer.Currency.Value,
            transfer.DepartedOn, transfer.ReceivedOn, transfer.Payee)
        {
            Kind = kind,
            Fee = fee,
            FeeBudgetItemId = transfer.Fee?.BudgetItemId,
            RecordedDate = recorded,
            SameReference = sameReference,
        };
    }
}
