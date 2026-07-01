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
            item = await _db.BudgetItems
                .Include(i => i.BudgetCategory)
                    .ThenInclude(c => c.BudgetMonth)
                .FirstOrDefaultAsync(i => i.Id == itemId, cancellationToken);

            if (item is null)
            {
                throw new NotFoundException($"Budget item {itemId} was not found.");
            }
            if (item.BudgetCategory.BudgetMonth.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
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

        // No line was chosen explicitly? Fall back to the budget line of the most
        // recent earlier transaction with the same description (a quiet, zero-config
        // default — no user-managed rules).
        if (item is null)
        {
            await AutoCategorizer.ApplyAsync(_db, userId, new[] { transaction }, cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);

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
