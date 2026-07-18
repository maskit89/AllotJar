using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

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

        // The slices must account for the whole transaction, to the cent.
        var allocated = request.Allocations.Sum(a => a.Amount);
        if (allocated != transaction.Amount)
        {
            throw Validation(
                $"The split lines must add up to {transaction.Amount:0.####}; they add up to {allocated:0.####}.");
        }

        // Load every target line once, owned by the user, with its kind.
        var itemIds = request.Allocations.Select(a => a.BudgetItemId).Distinct().ToList();
        var items = await _db.BudgetItems
            .Include(i => i.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Where(i => itemIds.Contains(i.Id))
            .ToDictionaryAsync(i => i.Id, cancellationToken);

        foreach (var id in itemIds)
        {
            if (!items.TryGetValue(id, out var item))
            {
                throw new NotFoundException($"Budget item {id} was not found.");
            }
            if (item.BudgetCategory.BudgetMonth.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }

            // Keep the roll-up coherent: split an expense across expense lines,
            // income across income lines.
            var lineIsIncome = item.BudgetCategory.Kind == CategoryKind.Income;
            var txIsIncome = transaction.Type == TransactionType.Income;
            if (lineIsIncome != txIsIncome)
            {
                throw Validation(txIsIncome
                    ? "Income can only be split across income lines."
                    : "An expense can only be split across expense lines.");
            }
        }

        // Any per-slice member attributions must belong to this user.
        var memberIds = request.Allocations
            .Where(a => a.MemberId is not null)
            .Select(a => a.MemberId!.Value)
            .Distinct()
            .ToList();
        if (memberIds.Count > 0)
        {
            var ownedMemberIds = await _db.HouseholdMembers
                .Where(m => memberIds.Contains(m.Id) && m.OwnerId == userId)
                .Select(m => m.Id)
                .ToListAsync(cancellationToken);
            var missing = memberIds.Except(ownedMemberIds).FirstOrDefault();
            if (missing != Guid.Empty)
            {
                throw new NotFoundException($"Household member {missing} was not found.");
            }
        }

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

    private static ValidationException Validation(string message) =>
        new(new Dictionary<string, string[]>
        {
            ["Allocations"] = new[] { message },
        });
}
