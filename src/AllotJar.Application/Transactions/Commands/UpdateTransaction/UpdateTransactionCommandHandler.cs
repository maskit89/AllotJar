using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Jars;
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
        var previousAccount = transaction.Account;
        // Serialise against other writers on the account that receives the edited row (rule 74).
        await using var write = account is null
            ? null
            : await _db.BeginLedgerWriteAsync(account.Id, cancellationToken);

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
        // those edits — the caller re-splits instead. Payee/account edits are fine; a date edit
        // that changes the month re-validates the slices below.
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

        var monthChanged = request.Date.Year != transaction.Date.Year
                           || request.Date.Month != transaction.Date.Month;

        // A retained whole-line assignment must stay valid under the edit: re-run the shared
        // invariant when the direction or the month changes. (Editing an assigned expense into
        // income used to keep the expense line — BudgetActuals then silently dropped the amount;
        // a date edit used to cross months with no acknowledgment.) Unrelated edits — payee,
        // amount, account — skip this, so a deliberately-acknowledged cross-month assignment
        // isn't re-prompted every time an unrelated field is touched.
        // Moving the payment to another account also re-runs it: a jar line's payment must keep
        // leaving the jar's account (rule 79).
        var accountChanged = request.AccountId != transaction.AccountId;
        if (transaction.BudgetItemId is Guid retainedLineId
            && (request.Type != transaction.Type || monthChanged || accountChanged))
        {
            await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, request.Type, retainedLineId, request.Date, request.AcknowledgeCrossMonth,
                accountChanged && !monthChanged && request.Type == transaction.Type ? "AccountId" : "Type",
                cancellationToken, request.AccountId);
        }

        // Same rule for a split: moving the transaction to another month moves every slice's
        // actuals month, so the slice lines are re-validated against the NEW date (with the same
        // acknowledge-to-confirm escape a fresh split would get).
        if (transaction.Splits.Count > 0 && (monthChanged || accountChanged))
        {
            var sliceItemIds = transaction.Splits
                .Where(s => s.BudgetItemId is not null)
                .Select(s => s.BudgetItemId!.Value)
                .Distinct()
                .ToList();
            var sliceItems = await _db.BudgetItems
                .Include(i => i.BudgetCategory)
                    .ThenInclude(c => c.BudgetMonth)
                .Include(i => i.Jar)
                    .ThenInclude(j => j!.FundingAccount)
                .Where(i => sliceItemIds.Contains(i.Id))
                .ToListAsync(cancellationToken);
            foreach (var line in sliceItems)
            {
                TransactionInvariants.EnsureWholeLineAssignable(
                    line, userId, transaction.Type, request.Date, request.AcknowledgeCrossMonth,
                    monthChanged ? "Date" : "AccountId", request.AccountId);
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
            // The bank legs describe the transfer that no longer exists; an income/expense row
            // has a single posting date (Date) and a single statement reference.
            transaction.DepartedOn = null;
            transaction.ReceivedOn = null;
            transaction.ReceiptBankReference = null;
        }
        transaction.Account = account;
        transaction.AccountId = account?.Id;
        transaction.Member = member;
        transaction.MemberId = member?.Id;

        // Rule 74 on every account the edit touches: the one losing the row as much as the one
        // receiving it (moving an income away, or shrinking it, can leave later payments uncovered).
        var affected = new[] { previousAccount, account }.Where(a => a is not null).Select(a => a!).ToList();
        if (affected.Count > 0)
        {
            await AccountBalanceGuard.EnsureNonNegativeAsync(
                _db, affected, new[] { transaction }, Array.Empty<Guid>(), "Amount", cancellationToken);
        }

        // The jar split of the previous leg no longer describes this row once it changes account
        // or direction; the edited leg carries the re-answered prompt (rules 78/79).
        if (previousAccount is not null && previousAccount.Id != account?.Id)
        {
            await JarMovements.ClearAsync(_db, transaction, previousAccount.Id, cancellationToken);
        }
        if (account is not null)
        {
            if (request.Type == TransactionType.Expense)
            {
                await JarMovements.ApplyOutgoingAsync(
                    _db, userId, transaction, account, request.PaidFromJarId, "PaidFromJarId", cancellationToken);
            }
            else
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

        return await TransactionReads.ReadDtoAsync(_db, transaction.Id, cancellationToken);
    }
}
