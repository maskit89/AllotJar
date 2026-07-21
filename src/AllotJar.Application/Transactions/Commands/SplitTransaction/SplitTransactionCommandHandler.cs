using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Transactions.Commands.SplitTransaction;

public class SplitTransactionCommandHandler : IRequestHandler<SplitTransactionCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SplitTransactionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(SplitTransactionCommand request, CancellationToken cancellationToken)
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

        // Shared slice rules (sum, ownership, direction match, member ownership) — the
        // same guard CreateTransaction uses for split-at-creation.
        var items = await TransactionInvariants.ValidateSlicesAsync(
            _db, userId, transaction.Type, transaction.Amount, request.Allocations,
            errorKey: "Allocations", cancellationToken);

        // Replace any previous split, and drop the whole-transaction assignment —
        // the slices carry the attribution now.
        if (transaction.Splits.Count > 0)
        {
            _db.TransactionSplits.RemoveRange(transaction.Splits);
            transaction.Splits.Clear();
        }
        transaction.BudgetItemId = null;

        foreach (var allocation in request.Allocations)
        {
            var item = items[allocation.BudgetItemId];

            _db.TransactionSplits.Add(new TransactionSplit
            {
                TransactionId = transaction.Id,
                BudgetItemId = item.Id,
                MemberId = allocation.MemberId,
                Amount = allocation.Amount,
            });
        }

        await _db.SaveChangesAsync(cancellationToken);

        // Re-read with line names so the DTO carries each slice's "assigned to". Include the
        // Account too so the response DTO's accountName is populated (matching how
        // CreateTransaction/GetTransactions load it).
        var saved = await _db.Transactions
            .AsNoTracking()
            .Include(t => t.BudgetItem)
            .Include(t => t.Account)
            .Include(t => t.Member)
            .Include(t => t.Splits)
                .ThenInclude(s => s.BudgetItem)
            .Include(t => t.Splits)
                .ThenInclude(s => s.Member)
            .FirstAsync(t => t.Id == transaction.Id, cancellationToken);

        return saved.ToDto();
    }
}
