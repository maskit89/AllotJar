using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
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

        // Under the account's ledger lock before the line's jar is checked, so the jar can't be
        // archived or moved between the check and the save (P11, #300 review P2-1).
        await using var write = transaction.Account is not null && transaction.Type == TransactionType.Expense
            ? await _db.BeginLedgerWriteAsync(transaction.Account.Id, cancellationToken)
            : null;

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
            // A refund follows its purchase onto expense/savings lines, never income (rule 38).
            var item = await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, TransactionInvariants.LineDirection(transaction), itemId, transaction.Date,
                request.AcknowledgeCrossMonth, "BudgetItemId", cancellationToken, transaction.AccountId);

            transaction.BudgetItem = item;
            transaction.BudgetItemId = item.Id;
            // Putting a kept shared side of an erased transfer on a line makes it an entry the
            // budget counts everywhere, as the owner asked (rule 31).
            transaction.CounterpartyErased = false;
        }
        else
        {
            transaction.BudgetItem = null;
            transaction.BudgetItemId = null;
        }

        // The line decides which jar a payment from a jar-backed account draws from (rule 79);
        // the stored answer is rewritten for the new line, or cleared back to the default.
        if (transaction.Account is not null && transaction.Type == TransactionType.Expense)
        {
            await JarMovements.ApplyOutgoingAsync(
                _db, userId, transaction, transaction.Account, request.PaidFromJarId, "PaidFromJarId", cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }
}
