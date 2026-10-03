using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common;
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
        if (transaction.FeeForTransferId is not null)
        {
            throw TransferFees.ChangedDirectly("TransactionId");
        }
        // The split editor saves the slices whole, so one loaded before someone else's change is
        // refused (D11). A split rewrites only the rows under the transaction, so this also writes
        // the transaction back: its version moves, and the next stale form (a split or an edit)
        // is refused too (#308 review P2-1).
        _db.ExpectVersion(transaction, request.Version);

        // A refund's whole amount reduces the one line it lands on (rules 38/39); slicing it
        // across lines would let a refund reduce categories the purchase never touched.
        if (transaction.IsRefund)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Allocations"] = new[] { "A refund follows one purchase and can't be split across lines." },
            });
        }

        // A refund stays on the line it landed on, so splitting its purchase onto other lines
        // would leave that line reading the refund with no purchase (D9, review TX-P3-3). As with
        // a delete, the user unlinks the refunds first; one in another login's private account
        // counts too (W13).
        var refunds = await RefundRules.AllRefundsAsync(_db, transaction.Id, cancellationToken);
        if (refunds.Count > 0)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Allocations"] = new[]
                {
                    refunds.Any(r => r.Hidden)
                        ? "This purchase has a refund linked to it in a private account. Its holder must unlink it before the purchase can be split."
                        : refunds.Count == 1
                            ? "This purchase has a refund linked to it. Unlink the refund before splitting the purchase."
                            : $"This purchase has {refunds.Count} refunds linked to it. Unlink them before splitting the purchase.",
                },
            });
        }

        // Slices are typed amounts, whole cents (D1); a row whose own amount carries more
        // decimals (a converted amount restated at four, P67) can only be split into slices
        // that add up to it.
        if (MoneyInput.IsWholeCents(transaction.Amount) && request.Allocations.Any(a => !MoneyInput.IsWholeCents(a.Amount)))
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Allocations"] = new[] { MoneyInput.TooPrecise },
            });
        }

        // Under the account's ledger lock before the slices' jars are checked, so a jar can't be
        // archived or moved between the check and the save (P11, #300 review P2-1).
        await using var write = transaction.Account is not null && transaction.Type == TransactionType.Expense
            ? await _db.BeginLedgerWriteAsync(transaction.Account.Id, cancellationToken)
            : null;

        // Shared slice rules (transfer rejection, sum, ownership, direction match, month
        // coherence, member ownership) — the same guard CreateTransaction uses for
        // split-at-creation. A slice on the line of a jar the account held on the transaction's
        // date in a stretch that has since ended is the departure's, not the arrival check's (P51).
        var items = await TransactionInvariants.ValidateSlicesAsync(
            _db, userId, transaction.Type, transaction.Amount, request.Allocations,
            transaction.Date, request.AcknowledgeCrossMonth,
            errorKey: "Allocations", cancellationToken, transaction.AccountId);

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
        // Slices put the row on lines, so a kept shared side of an erased transfer counts everywhere.
        transaction.CounterpartyErased = false;

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
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        // Re-read with line, member and jar names so the DTO carries each slice's "assigned to".
        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }
}
