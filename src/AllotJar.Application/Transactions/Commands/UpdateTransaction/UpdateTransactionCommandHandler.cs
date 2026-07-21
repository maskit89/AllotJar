using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.UpdateTransaction;

public class UpdateTransactionCommandHandler : IRequestHandler<UpdateTransactionCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateTransactionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<TransactionDto> Handle(UpdateTransactionCommand request, CancellationToken cancellationToken)
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

        // Moving a transaction onto an account of a different currency would corrupt that
        // account's (currency-blind) balance — reject it. The transaction's currency is not
        // changed here, so it must already match the account it's being attached to.
        TransactionInvariants.EnsureAccountCurrency(account, transaction.Currency, "AccountId");

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

        // A split transaction's slices carry its attribution and must keep summing to the whole.
        // Editing the amount, direction, or whole-transaction member of a split via the generic
        // update would silently desync the slices (double-counting in budget actuals), so reject
        // those edits — the caller re-splits instead. Other fields (date, payee, account) are fine.
        if (transaction.Splits.Count > 0)
        {
            var errors = new Dictionary<string, string[]>();
            var sliceSum = transaction.Splits.Sum(s => s.Amount);
            if (request.Amount != sliceSum)
            {
                errors["Amount"] = new[]
                {
                    $"This transaction is split across {transaction.Splits.Count} lines totalling {sliceSum:0.####}. Change the split before changing the amount.",
                };
            }
            if (request.Type != transaction.Type)
            {
                errors["Type"] = new[] { "Change the split before changing a split transaction's type." };
            }
            if (request.MemberId is not null)
            {
                errors["MemberId"] = new[] { "This transaction is split; attribute members on the individual slices, not the whole transaction." };
            }
            if (errors.Count > 0)
            {
                throw new ValidationException(errors);
            }
        }

        // A pending-FX row counts at face value (placeholder rate 1). If the user edits the
        // amount they are correcting that face value by hand — clear the flag so a later
        // reconcile pass can't stamp a real rate onto the corrected figure, which would
        // double-convert it. (There is no endpoint for entering a rate manually.)
        if (transaction.FxPending && request.Amount != transaction.Amount)
        {
            transaction.FxPending = false;
        }

        transaction.Date = request.Date;
        transaction.Payee = request.Payee.Trim();
        transaction.Amount = request.Amount;
        transaction.Type = request.Type;
        // Editing a transfer into a plain income/expense must drop the counterparty
        // link, or the stale TransferAccountId keeps phantom-crediting the other account
        // in the derived balances. (The validator already rejects Type=Transfer here, so
        // an updated row is never itself a transfer.)
        if (request.Type != TransactionType.Transfer)
        {
            transaction.TransferAccount = null;
            transaction.TransferAccountId = null;
        }
        transaction.Account = account;
        transaction.AccountId = account?.Id;
        transaction.Member = member;
        transaction.MemberId = member?.Id;

        await _db.SaveChangesAsync(cancellationToken);

        return transaction.ToDto();
    }
}
