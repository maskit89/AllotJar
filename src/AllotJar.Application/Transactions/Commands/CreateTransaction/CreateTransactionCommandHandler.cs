using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Budgets;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Application.Transactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Transactions.Commands.CreateTransaction;

public class CreateTransactionCommandHandler : IRequestHandler<CreateTransactionCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    // The identity service is optional (same pattern as CreateBudgetMonth) so the existing test
    // constructions stand; it is only consulted when the household has no budget month yet.
    public CreateTransactionCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<TransactionDto> Handle(CreateTransactionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Manual entries are in the household's budget currency (rules 63/85). Money paid in
        // another currency is entered as the budget-currency amount the user settled on; the
        // foreign figure only rides along for reference (OriginalAmount).
        var currency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken);
        if (request.OriginalCurrency is string originalCode && CurrencyCode.From(originalCode) == currency)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["OriginalCurrency"] = new[] { $"The budget is in {currency.Value} already; leave the other currency empty." },
            });
        }

        // A refund follows the purchase it comes back from (rules 38/39): the original must be
        // the user's own expense, dated on or before the refund, and not already refunded in full.
        Transaction? original = null;
        var isRefund = request.RefundOfTransactionId is not null;
        if (request.RefundOfTransactionId is Guid originalId)
        {
            original = await RefundRules.ValidateOriginalAsync(
                _db, userId, originalId, refundId: null, request.Date, request.Amount, cancellationToken);
        }

        BudgetItem? item = null;
        if (request.BudgetItemId is Guid itemId)
        {
            // Owner + direction/kind + month coherence (cross-month allowed only when the
            // request acknowledges it). A refund matches expense/savings lines, never income.
            item = await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, TransactionInvariants.LineDirection(request.Type, isRefund), itemId, request.Date,
                request.AcknowledgeCrossMonth, "BudgetItemId", cancellationToken, request.AccountId);
        }
        else if (original is not null)
        {
            // No line chosen: the refund lands where the purchase was budgeted, in its own month.
            item = await RefundRules.DefaultLineAsync(_db, userId, original, request.Date, request.AccountId, cancellationToken);
        }

        Account? account = null;
        if (request.AccountId is Guid accountId)
        {
            account = await _db.Accounts
                .FirstOrDefaultAsync(a => a.Id == accountId, cancellationToken);

            if (account is null)
            {
                throw new NotFoundException($"Account {accountId} was not found.");
            }
            if (account.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
        }
        // Serialise against the account's other writers so the rule 74 check below reads
        // committed money, never a stale balance.
        await using var write = account is null
            ? null
            : await _db.BeginLedgerWriteAsync(account.Id, cancellationToken);

        HouseholdMember? member = null;
        if (request.MemberId is Guid memberId)
        {
            member = await _db.HouseholdMembers
                .FirstOrDefaultAsync(m => m.Id == memberId, cancellationToken);

            if (member is null)
            {
                throw new NotFoundException($"Household member {memberId} was not found.");
            }
            if (member.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
        }

        // A transaction on an account must be in that account's currency (balances sum raw
        // amounts with no FX), so reject e.g. a EUR-budget entry pinned to a GBP account.
        TransactionInvariants.EnsureAccountCurrency(account, currency, "AccountId");

        var transaction = new Transaction
        {
            OwnerId = userId,
            Date = request.Date,
            Payee = request.Payee.Trim(),
            Amount = request.Amount,
            Currency = currency,
            OriginalAmount = request.OriginalAmount,
            OriginalCurrency = request.OriginalCurrency is null ? null : CurrencyCode.From(request.OriginalCurrency),
            Type = request.Type,
            BudgetItem = item,
            BudgetItemId = item?.Id,
            Account = account,
            AccountId = account?.Id,
            Member = member,
            MemberId = member?.Id,
            // Scalar FK only: the original is tracked by this context, and EF fixes the
            // navigation up on save.
            RefundOfTransactionId = original?.Id,
        };

        _db.Transactions.Add(transaction);

        // Split at creation: validate the slices with the same guard the post-hoc split
        // uses, then persist parent + children in the one SaveChanges — the transaction
        // either exists fully split or not at all.
        var hasSplits = request.Splits is { Count: > 0 };
        if (request.Splits is { Count: > 0 } splits)
        {
            await TransactionInvariants.ValidateSlicesAsync(
                _db, userId, request.Type, request.Amount, splits,
                request.Date, request.AcknowledgeCrossMonth,
                errorKey: "Splits", cancellationToken, request.AccountId);

            // Scalar FKs only, exactly like CommitImport — setting the BudgetItem
            // navigation here trips EF InMemory's duplicate tracking.
            foreach (var slice in splits)
            {
                transaction.Splits.Add(new TransactionSplit
                {
                    BudgetItemId = slice.BudgetItemId,
                    MemberId = slice.MemberId,
                    Amount = slice.Amount,
                });
            }
        }

        // No line was chosen explicitly? Fall back to the budget line of the most
        // recent earlier transaction with the same description (a quiet, zero-config
        // default — no user-managed rules). Slices ARE an assignment: without the
        // hasSplits guard the categorizer would set a whole-transaction line on a
        // split transaction, an illegal state BudgetActuals would double-count. A refund's
        // default is the purchase's line (above), never a payee's learned income line.
        if (item is null && !hasSplits && !isRefund)
        {
            await AutoCategorizer.ApplyAsync(_db, userId, new[] { transaction }, cancellationToken);
        }

        if (account is not null)
        {
            // Rule 74: the account must not dip below zero on any date once this is recorded.
            if (request.Type == TransactionType.Expense)
            {
                await AccountBalanceGuard.EnsureNonNegativeAsync(
                    _db, new[] { account }, new[] { transaction }, Array.Empty<Guid>(), "Amount", cancellationToken);
                // A payment on a jar's line from an account the jar has since left, dated while
                // that account held it, is stored as a draw on the jar there (R2-D1): the reader
                // can't derive it, as it can a payment from the jar's own account.
                if (request.PaidFromJarId is not null || transaction.BudgetItemId is not null || hasSplits)
                {
                    await JarMovements.ApplyOutgoingAsync(
                        _db, userId, transaction, account, request.PaidFromJarId, "PaidFromJarId", cancellationToken);
                }
            }
            else if (request.JarAllocations is { Count: > 0 })
            {
                await JarMovements.ApplyIncomingAsync(
                    _db, userId, transaction, account, transaction.Date, transaction.Amount, request.JarAllocations,
                    "JarAllocations", cancellationToken);
            }
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        // The slices, any jar split and the refund link were saved with scalar FKs, so re-read
        // with line, member, jar and purchase details for the DTO — the same shape the list returns.
        if (hasSplits || transaction.JarAllocations.Count > 0 || isRefund)
        {
            return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
        }

        // If the fallback filled in a line, hydrate its navigation so the returned
        // DTO carries the line name (AutoCategorizer only sets the foreign key).
        if (transaction.BudgetItem is null && transaction.BudgetItemId is Guid filledItemId)
        {
            transaction.BudgetItem = await _db.BudgetItems
                .FirstOrDefaultAsync(i => i.Id == filledItemId, cancellationToken);
        }

        return transaction.ToDto();
    }
}
