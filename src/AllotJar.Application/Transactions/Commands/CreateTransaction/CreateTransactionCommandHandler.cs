using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
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

    public CreateTransactionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(CreateTransactionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        BudgetItem? item = null;
        if (request.BudgetItemId is Guid itemId)
        {
            // Owner + direction/kind + month coherence (cross-month allowed only when the
            // request acknowledges it).
            item = await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, request.Type, itemId, request.Date, request.AcknowledgeCrossMonth,
                "BudgetItemId", cancellationToken);
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

        // Manual entries are in the budget's base currency for that month (no FX).
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .FirstOrDefaultAsync(
                m => m.OwnerId == userId
                     && m.Year == request.Date.Year
                     && m.Month == request.Date.Month,
                cancellationToken);
        var currency = month?.BaseCurrency ?? CurrencyCode.Eur;

        var transaction = new Transaction
        {
            OwnerId = userId,
            Date = request.Date,
            Payee = request.Payee.Trim(),
            Amount = request.Amount,
            Currency = currency,
            ExchangeRate = 1m,
            Type = request.Type,
            BudgetItem = item,
            BudgetItemId = item?.Id,
            Account = account,
            AccountId = account?.Id,
            Member = member,
            MemberId = member?.Id,
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
                errorKey: "Splits", cancellationToken);

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
        // split transaction, an illegal state BudgetActuals would double-count.
        if (item is null && !hasSplits)
        {
            await AutoCategorizer.ApplyAsync(_db, userId, new[] { transaction }, cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);

        // The slices were saved with scalar FKs, so re-read with line/member names for
        // the DTO — the same shape SplitTransaction returns.
        if (hasSplits)
        {
            var saved = await _db.Transactions
                .AsNoTracking()
                .Include(t => t.Account)
                .Include(t => t.Splits)
                    .ThenInclude(s => s.BudgetItem)
                .Include(t => t.Splits)
                    .ThenInclude(s => s.Member)
                .FirstAsync(t => t.Id == transaction.Id, cancellationToken);

            return saved.ToDto();
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
