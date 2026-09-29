using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.UpdateTransfer;

public class UpdateTransferCommandHandler : IRequestHandler<UpdateTransferCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public UpdateTransferCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<TransactionDto> Handle(UpdateTransferCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var transfer = await _db.Transactions
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Include(t => t.Fee)
            .FirstOrDefaultAsync(t => t.Id == request.TransactionId, cancellationToken)
            ?? throw new NotFoundException($"Transaction {request.TransactionId} was not found.");
        if (transfer.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        if (transfer.Type != TransactionType.Transfer)
        {
            throw Validation("TransactionId", "Only a transfer can be edited here.");
        }

        var from = await OwnedAccountAsync(request.FromAccountId, userId, cancellationToken);
        var to = await OwnedAccountAsync(request.ToAccountId, userId, cancellationToken);
        if (from.Currency != to.Currency)
        {
            throw Validation(nameof(request.ToAccountId), "Both accounts must use the same currency to transfer between them.");
        }

        EnsureConfirmedLegsKept(transfer, request);

        // A manually entered receipt earlier than the departure is a typo far more often than a
        // value-dated credit; dates a statement supplied are kept as the banks gave them.
        if (request.DepartedOn is DateOnly d && request.ReceivedOn is DateOnly r && r < d
            && (request.DepartedOn != transfer.DepartedOn || request.ReceivedOn != transfer.ReceivedOn))
        {
            throw Validation(nameof(request.ReceivedOn), "The receipt date can't be before the departure date.");
        }

        var previousSource = transfer.Account;
        var previousDestination = transfer.TransferAccount;
        // What the stored return (if any) was decided from: kept unless one of these changes.
        var previousReturn = await TransferReturns.BasisAsync(_db, transfer, cancellationToken);

        // Serialise against the other writers of every account the edit can take money from (the
        // rule 74 check below reads all four).
        await using var write = await _db.BeginLedgerWriteAsync(
            new[] { from.Id, to.Id, previousSource?.Id ?? from.Id, previousDestination?.Id ?? to.Id }, cancellationToken);

        transfer.Account = from;
        transfer.AccountId = from.Id;
        transfer.TransferAccount = to;
        transfer.TransferAccountId = to.Id;
        transfer.Amount = request.Amount;
        transfer.Currency = from.Currency;
        transfer.DepartedOn = request.DepartedOn;
        transfer.ReceivedOn = request.ReceivedOn;
        transfer.ReturnedOn = request.ReturnedOn;
        if (request.ReturnedOn is null)
        {
            transfer.ReturnBankReference = null;
        }
        transfer.Payee = string.IsNullOrWhiteSpace(request.Payee) ? "Transfer" : request.Payee.Trim();
        // The register's display date is the departure once known, else the receipt held for review.
        transfer.Date = request.DepartedOn ?? request.ReceivedOn!.Value;

        // Each leg's jar answer, re-answered (P7). A leg that moved to another account loses the
        // answer it gave there; a return means the destination never receives anything.
        if (previousSource is not null && previousSource.Id != from.Id)
        {
            await JarMovements.ClearAsync(_db, transfer, previousSource.Id, cancellationToken);
        }
        if (previousDestination is not null && previousDestination.Id != to.Id)
        {
            await JarMovements.ClearAsync(_db, transfer, previousDestination.Id, cancellationToken);
        }
        if (transfer.DepartedOn is null)
        {
            await JarMovements.ClearAsync(_db, transfer, from.Id, cancellationToken);
        }
        else
        {
            await JarMovements.ApplyOutgoingAsync(
                _db, userId, transfer, from, request.FromJarId, nameof(request.FromJarId), cancellationToken, keepDepartedDraw: true);
        }
        if (transfer.ReturnedOn is not null)
        {
            await JarMovements.ClearAsync(_db, transfer, to.Id, cancellationToken);
        }
        else
        {
            // A receipt still in transit keeps its answer for the day it is confirmed, as when recorded.
            await JarMovements.ApplyIncomingAsync(
                _db, userId, transfer, to, transfer.ReceivedOn ?? transfer.Date, transfer.Amount, request.JarAllocations,
                nameof(request.JarAllocations), cancellationToken);
        }

        // The return's jars (P72): recorded again only when the return, the account it left, the
        // amount or the departure's jars changed; otherwise it keeps what was decided when it was
        // recorded, whatever has happened to the jars since.
        await TransferReturns.SyncAsync(_db, transfer, from.Id, previousReturn, cancellationToken);

        var removed = new List<Guid>();
        var fee = await TransferFees.ApplyAsync(
            _db, _identity, userId, transfer, from, request.Fee, request.FeeBudgetItemId, request.AcknowledgeCrossMonth,
            request.FromJarId, nameof(request.Fee), removed, cancellationToken);

        // Rule 74 on every account the edit touches, before and after.
        var affected = new[] { previousSource, previousDestination, from, to }
            .Where(a => a is not null).Select(a => a!).DistinctBy(a => a.Id).ToList();
        await AccountBalanceGuard.EnsureNonNegativeAsync(
            _db, affected, fee is null ? new[] { transfer } : new[] { transfer, fee }, removed, nameof(request.Amount), cancellationToken);

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
        return await TransactionReads.ReadDtoAsync(_db, transfer.Id, cancellationToken);
    }

    /// <summary>
    /// A leg a bank statement confirmed keeps the bank's account, date and amount: the departure
    /// debited the source <c>amount + fee</c>, the receipt credited the destination <c>amount</c>,
    /// and a statement-confirmed return credited the source <c>amount</c> back on its date.
    /// </summary>
    private static void EnsureConfirmedLegsKept(Transaction transfer, UpdateTransferCommand request)
    {
        var errors = new Dictionary<string, string[]>();
        var oldFee = transfer.Fee?.Amount ?? 0m;
        var newFee = request.Fee ?? 0m;
        if (transfer.BankReference is not null)
        {
            if (request.FromAccountId != transfer.AccountId)
                errors[nameof(request.FromAccountId)] = new[] { Kept("departure", "account it left") };
            if (request.DepartedOn != transfer.DepartedOn)
                errors[nameof(request.DepartedOn)] = new[] { Kept("departure", $"date ({transfer.DepartedOn:yyyy-MM-dd})") };
            if (request.Amount + newFee != transfer.Amount + oldFee)
                errors[nameof(request.Amount)] = new[] { Kept("departure", $"amount ({transfer.Amount + oldFee:0.00} including any fee)") };
        }
        if (transfer.ReceiptBankReference is not null)
        {
            if (request.ToAccountId != transfer.TransferAccountId)
                errors[nameof(request.ToAccountId)] = new[] { Kept("receipt", "account it reached") };
            if (request.ReceivedOn != transfer.ReceivedOn)
                errors[nameof(request.ReceivedOn)] = new[] { Kept("receipt", $"date ({transfer.ReceivedOn:yyyy-MM-dd})") };
            if (request.Amount != transfer.Amount && !errors.ContainsKey(nameof(request.Amount)))
                errors[nameof(request.Amount)] = new[] { Kept("receipt", $"amount ({transfer.Amount:0.00})") };
        }
        if (transfer.ReturnBankReference is not null)
        {
            // The source's statement credited this amount back to this account on this date.
            if (request.ReturnedOn != transfer.ReturnedOn)
                errors[nameof(request.ReturnedOn)] = new[] { Kept("return", $"date ({transfer.ReturnedOn:yyyy-MM-dd})") };
            if (request.FromAccountId != transfer.AccountId && !errors.ContainsKey(nameof(request.FromAccountId)))
                errors[nameof(request.FromAccountId)] = new[] { Kept("return", "account it came back to") };
            if (request.Amount != transfer.Amount && !errors.ContainsKey(nameof(request.Amount)))
                errors[nameof(request.Amount)] = new[] { Kept("return", $"amount ({transfer.Amount:0.00})") };
        }
        if (errors.Count > 0)
        {
            throw new ValidationException(errors);
        }
    }

    private static string Kept(string leg, string what) =>
        $"The {leg} is confirmed by a bank statement, so it keeps the bank's {what}.";

    private async Task<Account> OwnedAccountAsync(Guid id, string userId, CancellationToken cancellationToken)
    {
        var account = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == id, cancellationToken)
            ?? throw new NotFoundException($"Account {id} was not found.");
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        return account;
    }

    private static ValidationException Validation(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
