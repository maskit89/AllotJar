using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Commands.ConfirmConvertedAmount;

public class ConfirmConvertedAmountCommandHandler : IRequestHandler<ConfirmConvertedAmountCommand, TransactionDto>
{
    private const string Key = "Amount";

    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public ConfirmConvertedAmountCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<TransactionDto> Handle(ConfirmConvertedAmountCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transaction = await _db.Transactions
            .Include(t => t.Splits)
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken);
        if (transaction is null)
        {
            throw new NotFoundException($"Transaction {request.TransactionId} was not found.");
        }
        if (transaction.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        if (!transaction.FxPending)
        {
            throw Refuse("This transaction already counts in the budget currency. Edit its amount instead.");
        }
        // Slices are in the row's own currency; the user splits the confirmed amount instead.
        if (transaction.Splits.Count > 0)
        {
            throw Refuse("This transaction is split. Remove the split, enter the amount, then split it again.");
        }

        // A refund must still fit its purchase, and a purchase must still cover its refunds,
        // once the amount counts (rules 38/39).
        if (transaction.RefundOfTransactionId is Guid originalId)
        {
            await RefundRules.ValidateOriginalAsync(
                _db, userId, originalId, transaction.Id, transaction.Date, request.Amount, cancellationToken);
        }
        var refunded = RefundRules.Refunded(await RefundRules.AllRefundsAsync(_db, transaction.Id, cancellationToken));
        if (request.Amount < refunded)
        {
            throw Refuse($"This purchase has {refunded:0.##} refunded against it; its amount can't be less than that.");
        }

        if (transaction.AccountId is not null)
        {
            // A row on an account is in that account's currency and its amount is the account's
            // money: only an account kept in another currency (from before rule 63) holds such a
            // row. Rewriting the amount would change that balance, so the confirmed figure is kept
            // beside it as what the row counts in the budget.
            transaction.BudgetAmount = request.Amount;
        }
        else
        {
            var budgetCurrency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken);
            if (transaction.Currency != budgetCurrency)
            {
                transaction.OriginalAmount = transaction.Amount;
                transaction.OriginalCurrency = transaction.Currency;
            }
            transaction.Amount = request.Amount;
            transaction.Currency = budgetCurrency;
        }
        transaction.FxPending = false;

        await _db.SaveChangesAsync(cancellationToken);
        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }

    private static ValidationException Refuse(string message) =>
        new(new Dictionary<string, string[]> { [Key] = new[] { message } });
}
