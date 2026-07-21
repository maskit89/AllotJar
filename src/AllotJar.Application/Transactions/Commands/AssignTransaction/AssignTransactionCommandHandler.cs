using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.AssignTransaction;

public class AssignTransactionCommandHandler : IRequestHandler<AssignTransactionCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public AssignTransactionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(AssignTransactionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transaction = await _db.Transactions
            .Include(t => t.BudgetItem)
            .Include(t => t.Account)
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

        // Assigning (or clearing) the whole transaction supersedes any split.
        if (transaction.Splits.Count > 0)
        {
            _db.TransactionSplits.RemoveRange(transaction.Splits);
            transaction.Splits.Clear();
        }

        if (request.BudgetItemId is Guid itemId)
        {
            // Owner + direction/kind + month coherence. Cross-month is allowed only when the
            // request explicitly acknowledges it (the client sets that after a confirm dialog).
            var item = await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, transaction.Type, itemId, transaction.Date, request.AcknowledgeCrossMonth,
                "BudgetItemId", cancellationToken);

            transaction.BudgetItem = item;
            transaction.BudgetItemId = item.Id;
        }
        else
        {
            transaction.BudgetItem = null;
            transaction.BudgetItemId = null;
        }

        await _db.SaveChangesAsync(cancellationToken);

        return transaction.ToDto();
    }
}
