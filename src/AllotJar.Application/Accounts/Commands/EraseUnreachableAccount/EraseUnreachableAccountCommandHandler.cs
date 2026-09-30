using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;

/// <summary>
/// Erases, unseen, a private account whose login has left the household (P59, Christopher's "Add"
/// and "Keep shared" of 30 September 2026). Only what nobody else could see goes: the account, its
/// entries off the budget, and its movements with other accounts nobody can reach. What the
/// household already saw stays and keeps counting as it did: an entry on a budget line or a refund
/// of a shared purchase stays as an entry with no account (as DeleteAccount keeps them), and the
/// shared side of a posted transfer stays as a plain entry on the shared account, with its date,
/// amount, bank reference, jar postings and fee, so no household figure and no statement history
/// changes.
/// </summary>
public class EraseUnreachableAccountCommandHandler : IRequestHandler<EraseUnreachableAccountCommand>
{
    public const string ErasedSourcePayee = "Transfer from an erased account";
    public const string ErasedDestinationPayee = "Transfer to an erased account";
    public const string ErasedReturnPayee = "Transfer to an erased account, returned";

    private readonly IApplicationDbContext _db;
    private readonly IIdentityService _identity;
    private readonly ICurrentUser _currentUser;

    public EraseUnreachableAccountCommandHandler(IApplicationDbContext db, IIdentityService identity, ICurrentUser currentUser)
    {
        _db = db;
        _identity = identity;
        _currentUser = currentUser;
    }

    public async Task Handle(EraseUnreachableAccountCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Only an account nobody can reach: anything a login can still see is that login's to delete.
        var unreachable = await UnreachableAccounts.UnreachableIdsAsync(_db, _identity, ownerId, cancellationToken);
        var account = unreachable.Contains(request.Id)
            ? await _db.Accounts.IgnoreQueryFilters().FirstOrDefaultAsync(a => a.Id == request.Id && a.OwnerId == ownerId, cancellationToken)
            : null;
        if (account is null)
        {
            throw new NotFoundException($"Account {request.Id} was not found among the accounts nobody can reach.");
        }
        if (!string.Equals(request.ConfirmName.Trim(), account.Name.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            throw Refuse("ConfirmName", "The name you typed doesn't match the account's name. Type it exactly to erase the account.");
        }

        // Everything that moves money in the account: its own rows, every transfer touching it
        // and the fee rows of transfers into it (a fee sits on the source).
        var rows = await _db.Transactions.IgnoreQueryFilters()
            .Include(t => t.Fee)
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId
                        && (t.AccountId == account.Id
                            || (t.Type == TransactionType.Transfer && t.TransferAccountId == account.Id)
                            || (t.FeeForTransfer != null && t.FeeForTransfer.TransferAccountId == account.Id)))
            .ToListAsync(cancellationToken);
        var byId = rows.ToDictionary(t => t.Id);

        // The other side of each transfer: a shared account the owner sees, another account nobody
        // can reach (erased with this one, as far as their common movements go), or an account
        // private to a member still here, whose movement is theirs to remove first.
        var otherIds = rows.Where(t => t.Type == TransactionType.Transfer)
            .SelectMany(t => new[] { t.AccountId, t.TransferAccountId })
            .Where(id => id is not null && id != account.Id)
            .Select(id => id!.Value)
            .Distinct()
            .ToList();
        var shared = await _db.Accounts.Where(a => otherIds.Contains(a.Id)).ToListAsync(cancellationToken);
        var sharedIds = shared.Select(a => a.Id).ToHashSet();
        var reachablePrivate = otherIds.Where(id => !sharedIds.Contains(id) && !unreachable.Contains(id)).ToHashSet();
        if (reachablePrivate.Count > 0)
        {
            var count = rows.Count(t => t.Type == TransactionType.Transfer
                                        && (reachablePrivate.Contains(t.AccountId ?? Guid.Empty) || reachablePrivate.Contains(t.TransferAccountId ?? Guid.Empty)));
            throw Refuse("Id",
                $"'{account.Name}' has {count} transfer{(count == 1 ? "" : "s")} with an account that is private to a member of the household. " +
                "Only they can change or delete those transfers. Ask them to delete the transfers, or to share the account, first.");
        }

        // Decide each row: erased, or kept as what the household could already see.
        var erased = new HashSet<Guid>();
        var keptWithoutAccount = new List<Transaction>();
        var keptOnSharedSide = new List<(Transaction Row, bool PrivateIsSource)>();
        foreach (var row in rows.Where(t => t.Type == TransactionType.Transfer))
        {
            var privateIsSource = row.AccountId == account.Id;
            var otherId = privateIsSource ? row.TransferAccountId : row.AccountId;
            // Posted on the shared side: a shared source posted its departure the moment it was
            // confirmed (and a return posts a second movement, kept below); a shared destination
            // posted only once the receipt arrived. A transfer still to depart, or one from the
            // erased account that came back before arriving, posted nothing there.
            var posted = otherId is Guid other && sharedIds.Contains(other)
                         && (privateIsSource ? row.ReceivedOn is not null && row.ReturnedOn is null : row.DepartedOn is not null);
            if (posted)
            {
                keptOnSharedSide.Add((row, privateIsSource));
            }
            else
            {
                erased.Add(row.Id);
            }
        }
        foreach (var row in rows.Where(t => t.Type != TransactionType.Transfer && t.FeeForTransferId is null))
        {
            var onTheBudget = row.BudgetItemId is not null || row.Splits.Any(s => s.BudgetItemId is not null);
            if (onTheBudget)
            {
                keptWithoutAccount.Add(row);
            }
            else
            {
                erased.Add(row.Id);
            }
        }
        // A refund of a purchase the household sees keeps netting it (P20); one of an erased
        // purchase goes with it.
        foreach (var row in rows.Where(t => t.RefundOfTransactionId is Guid && t.FeeForTransferId is null && t.Type != TransactionType.Transfer))
        {
            var purchase = row.RefundOfTransactionId!.Value;
            var purchaseErased = byId.TryGetValue(purchase, out var p) ? erased.Contains(p.Id) : false;
            if (purchaseErased)
            {
                erased.Add(row.Id);
                keptWithoutAccount.Remove(row);
            }
            else if (erased.Remove(row.Id))
            {
                keptWithoutAccount.Add(row);
            }
        }
        // A fee follows its transfer: gone with an erased one; a plain expense on its line beside
        // a kept one (on the shared source it stays where it is; on the erased source it stays
        // only when it is on a budget line, as any other entry here).
        var fees = rows.Where(t => t.FeeForTransferId is Guid).ToList();
        foreach (var fee in fees)
        {
            var transferErased = erased.Contains(fee.FeeForTransferId!.Value);
            if (transferErased || (fee.AccountId == account.Id && fee.BudgetItemId is null && !fee.Splits.Any(s => s.BudgetItemId is not null)))
            {
                erased.Add(fee.Id);
            }
            else if (fee.AccountId == account.Id)
            {
                keptWithoutAccount.Add(fee);
            }
        }

        // Rule 38: a refund elsewhere that names an erased purchase would point nowhere and read
        // as income; the owner unlinks it where they can see it first.
        var refundsElsewhere = await _db.Transactions.IgnoreQueryFilters()
            .CountAsync(t => t.RefundOfTransactionId != null && erased.Contains(t.RefundOfTransactionId.Value) && !erased.Contains(t.Id), cancellationToken);
        if (refundsElsewhere > 0)
        {
            throw Refuse("Id",
                $"{refundsElsewhere} refund{(refundsElsewhere == 1 ? "" : "s")} in another account {(refundsElsewhere == 1 ? "is" : "are")} linked to a purchase in '{account.Name}'. " +
                "Unlink or delete them on the Transactions page first.");
        }

        // The guard on the save would refuse a change to a row of an account it hides from the
        // owner; every account this erase touches that nobody can reach is let go the same way.
        _db.AllowErasing(account.Id);
        foreach (var id in otherIds.Where(unreachable.Contains))
        {
            _db.AllowErasing(id);
        }

        // Rule 74: a shared account must stay at or above zero on every date without the erased
        // movements (a kept side keeps its date and amount, so it changes nothing).
        await using var write = shared.Count == 0 ? null : await _db.BeginLedgerWriteAsync(shared.Select(a => a.Id), cancellationToken);
        await AccountBalanceGuard.EnsureNonNegativeAsync(_db, shared, Array.Empty<Transaction>(), erased.ToList(), "Id", cancellationToken);

        foreach (var row in rows.Where(t => erased.Contains(t.Id)))
        {
            foreach (var other in shared.Where(o => o.Id == row.AccountId || o.Id == row.TransferAccountId))
            {
                await JarMovements.ClearAsync(_db, row, other.Id, cancellationToken);
            }
            await TransferReturns.ClearAsync(_db, row.Id, cancellationToken);
        }
        foreach (var (row, privateIsSource) in keptOnSharedSide)
        {
            await KeepSharedSideAsync(row, privateIsSource, cancellationToken);
        }
        foreach (var row in keptWithoutAccount)
        {
            row.AccountId = null;
            row.FeeForTransferId = null;
            row.FeeForTransfer = null;
        }
        foreach (var fee in fees.Where(f => !erased.Contains(f.Id) && f.AccountId != account.Id))
        {
            fee.FeeForTransferId = null;
            fee.FeeForTransfer = null;
        }

        // The account's own jar history can't exist (rule 33: a private account holds no jar), so
        // its remaining allocations, if any, are removed with it rather than left dangling.
        var allocations = await _db.JarAllocations.Include(a => a.Postings)
            .Where(a => a.AccountId == account.Id || (a.TransactionId != null && erased.Contains(a.TransactionId.Value)))
            .ToListAsync(cancellationToken);
        _db.JarAllocations.RemoveRange(allocations);
        // Fee rows go before their transfers (the link restricts the delete).
        _db.Transactions.RemoveRange(rows.Where(t => erased.Contains(t.Id) && t.FeeForTransferId is not null));
        _db.Transactions.RemoveRange(rows.Where(t => erased.Contains(t.Id) && t.FeeForTransferId is null));
        // Its holders and privacy row go with it (explicitly, so every provider agrees).
        _db.AccountHolders.RemoveRange(await _db.AccountHolders.Where(h => h.AccountId == account.Id).ToListAsync(cancellationToken));
        _db.AccountPrivacies.RemoveRange(await _db.AccountPrivacies.Where(p => p.AccountId == account.Id).ToListAsync(cancellationToken));
        // A person's savings account and the allocation's source are ids with no foreign key
        // (#277 P3-5, as DeleteAccount clears them).
        foreach (var member in await _db.HouseholdMembers.Where(m => m.PersonalSavingsAccountId == account.Id).ToListAsync(cancellationToken))
        {
            member.PersonalSavingsAccountId = null;
        }
        foreach (var profile in await _db.AllocationProfiles.Where(p => p.SourceAccountId == account.Id).ToListAsync(cancellationToken))
        {
            profile.SourceAccountId = null;
        }
        _db.Accounts.Remove(account);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
    }

    /// <summary>
    /// The shared side of a posted transfer as a plain entry on the shared account: a receipt
    /// becomes income dated the receipt with the bank's reference for it, a departure an expense
    /// dated the departure with its reference. Its jar postings on that account stay keyed to it.
    /// A departure that came back keeps its return too, as an income dated the return with the
    /// return's reference (the identity the ledger gave that movement), and the jar shares the
    /// return gave back stay with it. Both are marked as the shared side of an erased account, so
    /// the reports and the register's totals skip them as they skipped the transfer.
    /// </summary>
    private async Task KeepSharedSideAsync(Transaction row, bool privateIsSource, CancellationToken cancellationToken)
    {
        if (privateIsSource)
        {
            row.AccountId = row.TransferAccountId;
            row.Type = TransactionType.Income;
            row.Date = row.ReceivedOn!.Value;
            // A row from before receipt references was known to the destination by the source's
            // reference (the migration's marker); that is the reference it keeps.
            row.BankReference = row.ReceiptBankReference ?? (row.ReceiptKnownBySourceReference ? row.BankReference : null);
            row.Payee = ErasedSourcePayee;
        }
        else
        {
            row.Type = TransactionType.Expense;
            row.Date = row.DepartedOn!.Value;
            row.Payee = ErasedDestinationPayee;
            if (row.ReturnedOn is DateOnly returnedOn)
            {
                var back = new Transaction
                {
                    Id = TransferLedger.ReturnLegId(row.Id),
                    OwnerId = row.OwnerId,
                    AccountId = row.AccountId,
                    Type = TransactionType.Income,
                    Date = returnedOn,
                    Amount = row.Amount,
                    Currency = row.Currency,
                    FxPending = row.FxPending,
                    OriginalAmount = row.OriginalAmount,
                    OriginalCurrency = row.OriginalCurrency,
                    BudgetAmount = row.BudgetAmount,
                    BankReference = row.ReturnBankReference,
                    Payee = ErasedReturnPayee,
                    Notes = row.Notes,
                    CounterpartyErased = true,
                };
                _db.Transactions.Add(back);
                // The return's stored operation (jar +S, unallocated −S, dated the return) becomes
                // the income's own leg: jar +S, unallocated +(amount − S), which sums to it.
                // A share kept at the day the return was marked by hand, before the bank's date
                // (Christopher's "Keep", R4-P3-1), stays a dated operation as it is; the income
                // then lands unallocated on the bank's date, as the transfer read before (R3-P3-1).
                foreach (var op in await _db.JarAllocations.Include(a => a.Postings)
                             .Where(a => a.ReturnOfTransferId == row.Id).ToListAsync(cancellationToken))
                {
                    if (op.Date < returnedOn)
                    {
                        op.Kind = JarAllocationKind.Movement;
                        op.ReturnOfTransferId = null;
                        continue;
                    }
                    var shares = op.Postings.Where(p => p.JarId is not null).Sum(p => p.Amount);
                    foreach (var unallocated in op.Postings.Where(p => p.JarId is null).ToList())
                    {
                        op.Postings.Remove(unallocated);
                        _db.JarAllocationPostings.Remove(unallocated);
                    }
                    if (row.Amount - shares != 0m)
                    {
                        op.Postings.Add(new JarAllocationPosting { JarId = null, Amount = row.Amount - shares });
                    }
                    op.Kind = JarAllocationKind.Movement;
                    op.TransactionId = back.Id;
                    op.Transaction = back;
                    op.ReturnOfTransferId = null;
                    op.Date = returnedOn;
                }
            }
        }
        row.TransferAccountId = null;
        row.TransferAccount = null;
        row.DepartedOn = null;
        row.ReceivedOn = null;
        row.ReturnedOn = null;
        row.ReceiptBankReference = null;
        row.ReturnBankReference = null;
        row.ReceiptKnownBySourceReference = false;
        row.AllocationKey = null;
        row.CounterpartyErased = true;
    }

    private static ValidationException Refuse(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
