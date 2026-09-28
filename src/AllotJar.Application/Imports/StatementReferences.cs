using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Imports;

/// <summary>
/// The one definition of "this statement account already knows this bank reference", shared
/// by preview, commit and the direct importers so the stages can never disagree about what is
/// a duplicate. A reference belongs to the account whose statement carried it: an
/// income/expense row and a transfer's source leg keep it in <see cref="Transaction.BankReference"/>
/// on <see cref="Transaction.AccountId"/>; a transfer's destination leg keeps it in
/// <see cref="Transaction.ReceiptBankReference"/> on <see cref="Transaction.TransferAccountId"/>
/// (rule 51). Rows recorded before receipt references existed stored an inbound transfer's
/// reference on the source leg (the migration marked them received on their date), so a
/// transfer whose receipt is recorded without a reference of its own is still honoured on the
/// destination side by its source reference. A transfer whose receipt is still unknown carries
/// nothing for the destination: its source reference is the other bank's, and the receipt row
/// that shares it is the very row the destination statement has yet to confirm.
/// Case-insensitive to agree with the unique indexes' CI collation.
/// </summary>
public static class StatementReferences
{
    public static async Task<HashSet<string>> KnownAsync(
        IApplicationDbContext db, string ownerId, Guid? accountId, CancellationToken cancellationToken)
    {
        var known = await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && ((t.AccountId == accountId && t.BankReference != null)
                            || (accountId != null && t.Type == TransactionType.Transfer
                                && t.TransferAccountId == accountId
                                && (t.ReceiptBankReference != null
                                    || (t.ReceivedOn != null && t.BankReference != null)))))
            .Select(t => t.AccountId == accountId
                ? t.BankReference!
                : (t.ReceiptBankReference ?? t.BankReference!))
            .ToListAsync(cancellationToken);
        return new HashSet<string>(known, StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Recorded transfers that a statement row on <paramref name="accountId"/> could be the
    /// other side of: the account sits on the complementary leg, that leg is still unknown, and
    /// the amount and currency agree. Every such transfer is listed regardless of date — date
    /// tolerance for suggestions is not an agreed rule, so the user sees them all and chooses.
    /// </summary>
    public static async Task<List<Transaction>> OpenTransferLegsAsync(
        IApplicationDbContext db, string ownerId, Guid accountId, CancellationToken cancellationToken) =>
        await db.Transactions
            .AsNoTracking()
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Transfer
                        && t.AccountId != null && t.TransferAccountId != null
                        && ((t.TransferAccountId == accountId && t.ReceivedOn == null)
                            || (t.AccountId == accountId && t.DepartedOn == null)))
            .ToListAsync(cancellationToken);

    /// <summary>
    /// Whether <paramref name="transfer"/> is open on the leg a row on <paramref name="accountId"/>
    /// would confirm: a credit confirms receipt into the account, a debit confirms departure from it.
    /// </summary>
    public static bool IsOpenFor(Transaction transfer, Guid accountId, bool isCredit) =>
        isCredit
            ? transfer.TransferAccountId == accountId && transfer.ReceivedOn is null
            : transfer.AccountId == accountId && transfer.DepartedOn is null;
}
