using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Enums;

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
            if (request.BudgetItemId is Guid itemId)
            {
                var item = await TransactionInvariants.ValidateWholeLineAsync(
                    _db, userId, TransactionType.Expense, itemId, transaction.Date, request.AcknowledgeCrossMonth,
                    "BudgetItemId", cancellationToken, transaction.AccountId);
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

        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }

    private static ValidationException Refuse(string message) =>
        new(new Dictionary<string, string[]> { [RefundRules.Key] = new[] { message } });
}
