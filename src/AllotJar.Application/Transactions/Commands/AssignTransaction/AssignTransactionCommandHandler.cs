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
        // Clearing a split, or a new "paid from" answer on the line the row already has, rewrites
        // only the rows under the transaction: written back too, its version moves, so an edit or
        // split form loaded before this is refused rather than putting its answers back (D11,
        // #308 review P2-1). A one-click action, so nothing is checked.
        _db.TouchVersion(transaction);

        // A refund stays on the line it landed on, so moving its purchase to another line (or off
        // every line, or folding its split onto one) would leave that line reading the refund with
        // no purchase (D9, #306 review P2-3). Refused as a split is: the user unlinks the refunds
        // first; one in another login's private account counts too (W13).
        if (request.BudgetItemId != transaction.BudgetItemId || transaction.Splits.Count > 0)
        {
            var refunds = await RefundRules.AllRefundsAsync(_db, transaction.Id, cancellationToken);
            if (refunds.Count > 0)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["BudgetItemId"] = new[]
                    {
                        refunds.Any(r => r.Hidden)
                            ? "This purchase has a refund linked to it in a private account. Its holder must unlink it before the purchase can be moved to another line."
                            : refunds.Count == 1
                                ? "This purchase has a refund linked to it. Unlink the refund before moving the purchase to another line."
                                : $"This purchase has {refunds.Count} refunds linked to it. Unlink them before moving the purchase to another line.",
                    },
                });
            }
        }

        // Under the account's ledger lock before the line's jar is checked, so the jar can't be
        // archived or moved between the check and the save (P11, #300 review P2-1).
        await using var write = transaction.Account is not null && transaction.Type == TransactionType.Expense
            ? await _db.BeginLedgerWriteAsync(transaction.Account.Id, cancellationToken)
            : null;
        // A line moved onto or off a Recurring jar's replants that jar (JarDrawReplants).
        var jarsBefore = await JarDrawReplants.BeforeAsync(_db, userId, new[] { transaction.Id }, cancellationToken);

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
            // A refund may sit on its purchase's jar line from any account it reached (O9a).
            var refundOfJars = transaction.RefundOfTransactionId is Guid purchaseId
                && await _db.Transactions.FirstOrDefaultAsync(t => t.Id == purchaseId, cancellationToken) is { } purchase
                ? await RefundRules.PurchaseJarsAsync(_db, purchase, cancellationToken)
                : null;
            var item = await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, TransactionInvariants.LineDirection(transaction), itemId, transaction.Date,
                request.AcknowledgeCrossMonth, "BudgetItemId", cancellationToken, transaction.AccountId, refundOfJars);

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
        await JarDrawReplants.ReplantAsync(_db, userId, jarsBefore, new[] { transaction.Id }, cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }
}
