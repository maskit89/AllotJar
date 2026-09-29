using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports;
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
    private readonly IIdentityService? _identity;

    public UpdateTransactionCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<TransactionDto> Handle(UpdateTransactionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transaction = await _db.Transactions
            .Include(t => t.BudgetItem)
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Include(t => t.Splits)
            .Include(t => t.Fee)
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
        // A transfer's other side: it loses the credit when the row stops being a transfer.
        var previousDestination = transaction.Type == TransactionType.Transfer ? transaction.TransferAccount : null;
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

        // What the row counts in the budget before and after this edit. A row whose amount is an
        // account's other currency counts its fixed budget figure; changing that amount leaves the
        // figure behind, so the row waits for its new one (rule 44).
        var countedBefore = ForeignAmounts.Counted(transaction);
        var restatesAccountMoney = transaction.BudgetAmount is not null && request.Amount != transaction.Amount;
        decimal? countedAfter = transaction.FxPending || restatesAccountMoney
            ? null
            : transaction.BudgetAmount ?? request.Amount;

        // A refund stays money received and keeps fitting the purchase it refunds (rules 38/39):
        // its date can't move before the purchase and the purchase's refunds can't exceed it.
        // The link itself is changed through LinkRefund, so an edit never silently turns a
        // refund into income.
        if (transaction.IsRefund)
        {
            if (request.Type != TransactionType.Income)
            {
                throw new ValidationException(new Dictionary<string, string[]>
                {
                    ["Type"] = new[] { "A refund is money received. To record it as a payment, first unmark it as a refund." },
                });
            }
            // A refund still waiting for its budget-currency amount counts nothing yet (rule 44);
            // the fit is checked only when the refund would count more than it did.
            await RefundRules.ValidateOriginalAsync(
                _db, userId, transaction.RefundOfTransactionId!.Value, transaction.Id, request.Date,
                countedAfter, cancellationToken, previousAmount: countedBefore);
        }

        // A purchase with refunds linked to it stays a purchase that covers them: still an
        // expense, not shrunk below what came back, and not moved after the money returned.
        // Every refund counts, including one in another login's private account (W13); its
        // amount and date are then not named.
        var refunds = await RefundRules.AllRefundsAsync(_db, transaction.Id, cancellationToken);
        if (refunds.Count > 0)
        {
            var hidden = refunds.Any(r => r.Hidden);
            var errors = new Dictionary<string, string[]>();
            if (request.Type != TransactionType.Expense)
            {
                errors["Type"] = new[] { "This purchase has refunds linked to it. Unmark them as refunds before changing its type." };
            }
            // Budget-currency amounts on both sides; a row still waiting for its amount counts
            // nothing, so a waiting purchase has nothing to compare yet (rule 44). Only lowering
            // the purchase is checked, so an edit that keeps its figure is never refused.
            var refunded = RefundRules.Refunded(refunds);
            if (countedAfter is decimal after && (countedBefore is not decimal before || after < before) && after < refunded)
            {
                errors["Amount"] = new[]
                {
                    hidden
                        ? "This purchase has refunds against it; its amount can't be less than what came back."
                        : $"This purchase has {refunded:0.##} refunded against it; its amount can't be less than that.",
                };
            }
            var firstRefund = refunds.Min(r => r.Date);
            if (request.Date > firstRefund)
            {
                errors["Date"] = new[]
                {
                    hidden
                        ? "This purchase has a refund dated before that; it can't be dated after its refund."
                        : $"This purchase was refunded on {firstRefund:d MMM yyyy}; it can't be dated after its refund.",
                };
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
        // A draw kept from an earlier stretch the jar spent in this account (it moved away and
        // back) is its departure's (P51), whichever check the date edit runs.
        var kept = accountChanged || request.Date == transaction.Date
            ? new List<Guid>()
            : await TransactionInvariants.KeptDrawJarsAsync(_db, transaction.Id, request.AccountId, request.Date, cancellationToken);
        if (transaction.BudgetItemId is Guid retainedLineId
            && (request.Type != transaction.Type || monthChanged || accountChanged))
        {
            await TransactionInvariants.ValidateWholeLineAsync(
                _db, userId, TransactionInvariants.LineDirection(request.Type, transaction.IsRefund), retainedLineId,
                request.Date, request.AcknowledgeCrossMonth,
                accountChanged && !monthChanged && request.Type == transaction.Type ? "AccountId" : "Type",
                cancellationToken, request.AccountId, kept);
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
                    monthChanged ? "Date" : "AccountId", request.AccountId, kept);
            }
        }

        // A date edit within the month skips those checks, but a payment on a jar's line from the
        // jar's account still can't move to before the day the jar arrived there (P2-20): the
        // ledger would take it off the jar without a word. A draw kept from an earlier stretch
        // the jar spent in this account (it moved away and back) is its departure's (P51).
        if (request.Date != transaction.Date)
        {
            var lineIds = transaction.Splits.Count > 0
                ? transaction.Splits.Where(s => s.BudgetItemId is not null).Select(s => s.BudgetItemId!.Value).Distinct().ToList()
                : transaction.BudgetItemId is Guid lineId ? new List<Guid> { lineId } : new List<Guid>();
            await TransactionInvariants.EnsureJarLinesArrivedAsync(_db, lineIds, request.AccountId, request.Date, "Date", cancellationToken, kept);
        }

        // An imported row keeps what its bank printed the first time it is changed, so importing
        // that statement again recognises the entry instead of offering it anew (rule 88).
        if (transaction.BankReference is not null && transaction.BankEntry is null
            && (request.Date != transaction.Date || request.Amount != transaction.Amount || request.Type != transaction.Type))
        {
            transaction.BankEntry = StatementReferences.Entry(
                transaction.Type == TransactionType.Transfer ? transaction.DepartedOn ?? transaction.Date : transaction.Date,
                transaction.Type == TransactionType.Transfer ? transaction.Amount + (transaction.Fee?.Amount ?? 0m) : transaction.Amount,
                transaction.Type == TransactionType.Income);
        }

        transaction.Date = request.Date;
        transaction.Payee = request.Payee.Trim();
        // The amount stays in the row's own currency: editing a row that waits for its
        // budget-currency amount corrects the foreign figure and the row keeps waiting (rule 44).
        transaction.Amount = request.Amount;
        if (restatesAccountMoney)
        {
            transaction.BudgetAmount = null;
            transaction.FxPending = true;
            ForeignAmounts.ShareOverSlices(transaction);
        }
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
            transaction.ReturnedOn = null;
            transaction.ReturnBankReference = null;
            await TransferReturns.ClearAsync(_db, transaction.Id, cancellationToken);
            transaction.AllocationKey = null;
        }
        transaction.Account = account;
        transaction.AccountId = account?.Id;
        transaction.Member = member;
        transaction.MemberId = member?.Id;

        // Rule 74 on every account the edit touches: the one losing the row as much as the one
        // receiving it (moving an income away, or shrinking it, can leave later payments uncovered),
        // and the destination of a transfer that stops being one — its receipt is what the edit
        // takes away, so the money spent from it since must still be covered.
        // A transfer's fee goes with the transfer.
        var removed = new List<Guid>();
        if (request.Type != TransactionType.Transfer && transaction.Fee is Transaction fee && previousAccount is not null)
        {
            await TransferFees.ApplyAsync(
                _db, _identity, userId, transaction, previousAccount, null, null, false, null, "Amount", removed, cancellationToken);
        }
        var affected = new[] { previousAccount, previousDestination, account }.Where(a => a is not null).Select(a => a!).ToList();
        if (affected.Count > 0)
        {
            await AccountBalanceGuard.EnsureNonNegativeAsync(
                _db, affected, new[] { transaction }, removed, "Amount", cancellationToken);
        }

        // The jar split of the previous leg no longer describes this row once it changes account
        // or direction; the edited leg carries the re-answered prompt (rules 78/79). The receipt
        // leg's split goes with the receipt.
        if (previousAccount is not null && previousAccount.Id != account?.Id)
        {
            await JarMovements.ClearAsync(_db, transaction, previousAccount.Id, cancellationToken);
        }
        if (previousDestination is not null && previousDestination.Id != account?.Id)
        {
            await JarMovements.ClearAsync(_db, transaction, previousDestination.Id, cancellationToken);
        }
        if (account is not null)
        {
            if (request.Type == TransactionType.Expense)
            {
                await JarMovements.ApplyOutgoingAsync(
                    _db, userId, transaction, account, request.PaidFromJarId, "PaidFromJarId", cancellationToken,
                    keepDepartedDraw: true);
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
