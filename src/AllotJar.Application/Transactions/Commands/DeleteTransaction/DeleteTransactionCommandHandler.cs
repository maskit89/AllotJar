using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Transactions.Commands.DeleteTransaction;

public class DeleteTransactionCommandHandler : IRequestHandler<DeleteTransactionCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DeleteTransactionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(DeleteTransactionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transaction = await _db.Transactions
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Include(t => t.Fee)
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken);

        if (transaction is null)
        {
            throw new NotFoundException($"Transaction {request.TransactionId} was not found.");
        }
        if (transaction.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (transaction.FeeForTransferId is not null)
        {
            throw TransferFees.ChangedDirectly("TransactionId");
        }

        // Rule 38: a refund and its purchase both stay in history. Deleting the purchase would
        // leave its refunds pointing nowhere — and, unlinked, they would silently become income —
        // so the user unlinks or deletes the refunds first.
        // A refund in another login's private account counts too (W13): its holder unlinks it.
        var refunds = await RefundRules.AllRefundsAsync(_db, transaction.Id, cancellationToken);
        if (refunds.Count > 0)
        {
            var count = refunds.Count;
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["TransactionId"] = new[]
                {
                    refunds.Any(r => r.Hidden)
                        ? "This purchase has a refund linked to it in a private account. Its holder must unlink or delete it first."
                        : count == 1
                            ? "This purchase has a refund linked to it. Unlink or delete the refund first."
                            : $"This purchase has {count} refunds linked to it. Unlink or delete them first.",
                },
            });
        }

        // Rule 74: removing money that reached an account (an income, a receipt) can leave later
        // payments uncovered; the account must stay at or above zero on every date without it.
        var affected = new[] { transaction.Account, transaction.TransferAccount }.Where(a => a is not null).Select(a => a!).ToList();
        await using var write = affected.Count == 0
            ? null
            : await _db.BeginLedgerWriteAsync(affected[0].Id, cancellationToken);
        if (affected.Count > 0)
        {
            // A transfer's fee goes with it.
            var removed = transaction.Fee is Transaction fee ? new[] { transaction.Id, fee.Id } : new[] { transaction.Id };
            await AccountBalanceGuard.EnsureNonNegativeAsync(
                _db, affected, Array.Empty<Transaction>(), removed, "TransactionId", cancellationToken);
        }
        if (transaction.Fee is Transaction feeRow)
        {
            if (feeRow.AccountId is Guid feeAccountId)
            {
                await Jars.JarMovements.ClearAsync(_db, feeRow, feeAccountId, cancellationToken);
            }
            _db.Transactions.Remove(feeRow);
        }

        // Each leg's jar split goes first, through the one writer that keeps a departed jar's
        // history balanced (rule 80); the cascade then has nothing left to remove.
        foreach (var legAccount in affected)
        {
            await Jars.JarMovements.ClearAsync(_db, transaction, legAccount.Id, cancellationToken);
        }
        _db.Transactions.Remove(transaction);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
    }
}
