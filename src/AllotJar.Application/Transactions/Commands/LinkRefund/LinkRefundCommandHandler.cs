using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Transactions.Commands.LinkRefund;

public class LinkRefundCommandHandler : IRequestHandler<LinkRefundCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public LinkRefundCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(LinkRefundCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transaction = await _db.Transactions
            .Include(t => t.BudgetItem)
                .ThenInclude(i => i!.BudgetCategory)
            .Include(t => t.Splits)
            .Include(t => t.Refunds)
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken);

        if (transaction is null)
        {
            throw new NotFoundException($"Transaction {request.TransactionId} was not found.");
        }
        if (transaction.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        // Linking the purchase it already follows can still refill a jar (O9b), a write under the
        // receipt alone: written back too, its version moves, so an edit form loaded before this
        // can't replace the refill with its old jar answer (D11, #308 review P2-1).
        _db.TouchVersion(transaction);

        // The line chosen below can be a jar's (rule 79): its account is locked before the line's
        // jar is checked, so a move or archive of the jar can't slip in between (P11).
        await using var write = transaction.AccountId is Guid accountId
            ? await _db.BeginLedgerWriteAsync(accountId, cancellationToken)
            : null;

        if (request.RefundOfTransactionId is Guid originalId)
        {
            // Only money received can come back from a purchase; a purchase with refunds of its
            // own, or a split row, is not a refund.
            if (transaction.Type != TransactionType.Income)
            {
                throw Refuse(transaction.Type == TransactionType.Transfer
                    ? "A transfer can't be a refund. Only money received can be marked as a refund of a purchase."
                    : "Only money received can be marked as a refund. This is a payment; if it was refunded, mark the refund instead.");
            }
            if (transaction.Splits.Count > 0)
            {
                throw Refuse("A split transaction can't be a refund. Remove the split first.");
            }
            if (transaction.FxPending)
            {
                throw Refuse(
                    $"This is in {transaction.Currency.Value} and is waiting for its amount in the budget currency. " +
                    "Enter that amount before marking it as a refund.");
            }

            var original = await RefundRules.ValidateOriginalAsync(
                _db, userId, originalId, transaction.Id, transaction.Date, ForeignAmounts.Counted(transaction), cancellationToken);
            transaction.RefundOfTransactionId = original.Id;

            // The row now matches expense/savings lines only (rules 38/39): a chosen line is
            // validated as such; otherwise it leaves any income line for the purchase's line in
            // its own month, or stays uncategorised for the user to place.
            // A refund may sit on its purchase's jar line from any account it reached (O9a).
            if (request.BudgetItemId is Guid itemId)
            {
                var item = await TransactionInvariants.ValidateWholeLineAsync(
                    _db, userId, TransactionType.Expense, itemId, transaction.Date, request.AcknowledgeCrossMonth,
                    "BudgetItemId", cancellationToken, transaction.AccountId,
                    await RefundRules.PurchaseJarsAsync(_db, original, cancellationToken));
                transaction.BudgetItem = item;
                transaction.BudgetItemId = item.Id;
            }
            else if (transaction.BudgetItem is null || transaction.BudgetItem.BudgetCategory.Kind == CategoryKind.Income)
            {
                var item = await RefundRules.DefaultLineAsync(
                    _db, userId, original, transaction.Date, transaction.AccountId, cancellationToken);
                transaction.BudgetItem = item;
                transaction.BudgetItemId = item?.Id;
            }

            // O9b: money back from a completed Goal's purchase, or a paid cycle's payment, goes back
            // into the jar when it reached the jar's account and nothing was answered for it yet.
            // The receipt is already in the ledger as unallocated money, which may have been spent
            // or moved since it arrived: the refill is a move out of unallocated funds on the
            // receipt's date, made only when unallocated stays at or above zero (and no jar is left
            // unbacked) on that date and every later one; otherwise the money stays unallocated
            // for the user to place (PR #305 review round 1, P2-2).
            if (transaction.AccountId is Guid refundAccountId
                && await RefundRules.JarToRefillAsync(_db, original, refundAccountId, transaction.Date, cancellationToken) is { } jar
                && !await _db.JarAllocations.AnyAsync(a => a.TransactionId == transaction.Id, cancellationToken)
                && await _db.Accounts.FirstAsync(a => a.Id == refundAccountId, cancellationToken) is var account
                && await RefillKeepsUnallocatedAsync(userId, account, jar.Id, transaction, cancellationToken))
            {
                await JarMovements.ApplyIncomingAsync(
                    _db, userId, transaction, account, transaction.Date, transaction.Amount,
                    new[] { new JarAllocationInput(jar.Id, transaction.Amount) }, RefundRules.Key, cancellationToken);
            }
        }
        else
        {
            // Unlinking makes the row plain income again, so it can no longer sit on an expense
            // line; it takes the income line the user chose, or none.
            transaction.RefundOfTransactionId = null;
            transaction.RefundOf = null;
            if (request.BudgetItemId is Guid itemId)
            {
                var item = await TransactionInvariants.ValidateWholeLineAsync(
                    _db, userId, transaction.Type, itemId, transaction.Date, request.AcknowledgeCrossMonth,
                    "BudgetItemId", cancellationToken, transaction.AccountId);
                transaction.BudgetItem = item;
                transaction.BudgetItemId = item.Id;
            }
            else if (transaction.BudgetItem is not null
                     && !TransactionInvariants.LineKindMatches(transaction.BudgetItem.BudgetCategory.Kind, transaction.Type))
            {
                transaction.BudgetItem = null;
                transaction.BudgetItemId = null;
            }
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }

    /// <summary>
    /// Whether moving the receipt's amount from the account's unallocated money into
    /// <paramref name="jarId"/> on the receipt's date holds on every date from it (rules 68, 70
    /// across history, as a dated reallocation is checked): unallocated never drops below zero and
    /// no jar is left unbacked.
    /// </summary>
    private async Task<bool> RefillKeepsUnallocatedAsync(
        string userId, Account account, Guid jarId, Transaction receipt, CancellationToken cancellationToken)
    {
        var ledger = await JarLedgerReader.LoadAsync(_db, userId, cancellationToken, new[] { account.Id }, includeUnbacked: true);
        var postings = new[] { new JarLedgerPosting(null, -receipt.Amount), new JarLedgerPosting(jarId, receipt.Amount) };
        return JarHistoryChecks.FirstRefusal(
            ledger, account, receipt.Date, includeFrom: true, sourceJarId: null, "Unallocated funds",
            receipt.Amount, 0m, postings) is null;
    }

    private static ValidationException Refuse(string message) =>
        new(new Dictionary<string, string[]> { [RefundRules.Key] = new[] { message } });
}
