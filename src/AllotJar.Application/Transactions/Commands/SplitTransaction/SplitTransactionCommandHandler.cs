using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Enums;
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

        // A refund's whole amount reduces the one line it lands on (rules 38/39); slicing it
        // across lines would let a refund reduce categories the purchase never touched.
        if (transaction.IsRefund)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Allocations"] = new[] { "A refund follows one purchase and can't be split across lines." },
            });
        }

        // Shared slice rules (transfer rejection, sum, ownership, direction match, month
        // coherence, member ownership) — the same guard CreateTransaction uses for
        // split-at-creation. A draw kept from an earlier stretch the jar spent in this account
        // (it moved away and back) is its departure's, not the arrival check's (P51).
        var kept = await TransactionInvariants.KeptDrawJarsAsync(_db, transaction.Id, transaction.AccountId, transaction.Date, cancellationToken);
        var items = await TransactionInvariants.ValidateSlicesAsync(
            _db, userId, transaction.Type, transaction.Amount, request.Allocations,
            transaction.Date, request.AcknowledgeCrossMonth,
            errorKey: "Allocations", cancellationToken, transaction.AccountId, kept);

        // Replace any previous split, and drop BOTH whole-transaction attributions — line AND
        // member — since the slices carry them now. Leaving the whole-member in place would let
        // a stale attribution silently reappear if the split is later removed (unsplit via
        // AssignTransaction), double-attributing the member's history.
        if (transaction.Splits.Count > 0)
        {
            _db.TransactionSplits.RemoveRange(transaction.Splits);
            transaction.Splits.Clear();
        }
        transaction.BudgetItemId = null;
        transaction.Member = null;
        transaction.MemberId = null;

        var slices = new List<TransactionSplit>();
        foreach (var allocation in request.Allocations)
        {
            var item = items[allocation.BudgetItemId];

            var slice = new TransactionSplit
            {
                TransactionId = transaction.Id,
                BudgetItemId = item.Id,
                MemberId = allocation.MemberId,
                Amount = allocation.Amount,
            };
            _db.TransactionSplits.Add(slice);
            slices.Add(slice);
        }
        // A row whose amount is an account's other currency counts its fixed budget figure; each
        // slice counts its share of it.
        ForeignAmounts.ShareOverSlices(transaction, slices);

        // Each slice's line decides the jar it draws from (rule 79); the stored answer for the
        // non-jar slices is rewritten with the new split.
        if (transaction.Account is not null && transaction.Type == TransactionType.Expense)
        {
            await JarMovements.ApplyOutgoingAsync(
                _db, userId, transaction, transaction.Account, request.PaidFromJarId, "PaidFromJarId", cancellationToken, slices);
        }

        await _db.SaveChangesAsync(cancellationToken);

        // Re-read with line, member and jar names so the DTO carries each slice's "assigned to".
        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }
}
