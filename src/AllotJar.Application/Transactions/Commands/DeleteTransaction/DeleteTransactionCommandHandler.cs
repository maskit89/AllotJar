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
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken);

        if (transaction is null)
        {
            throw new NotFoundException($"Transaction {request.TransactionId} was not found.");
        }
        if (transaction.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Rule 74: removing money that reached an account (an income, a receipt) can leave later
        // payments uncovered; the account must stay at or above zero on every date without it.
        var affected = new[] { transaction.Account, transaction.TransferAccount }.Where(a => a is not null).Select(a => a!).ToList();
        await using var write = affected.Count == 0
            ? null
            : await _db.BeginLedgerWriteAsync(affected[0].Id, cancellationToken);
        if (affected.Count > 0)
        {
            await AccountBalanceGuard.EnsureNonNegativeAsync(
                _db, affected, Array.Empty<Transaction>(), new[] { transaction.Id }, "TransactionId", cancellationToken);
        }

        _db.Transactions.Remove(transaction);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
    }
}
