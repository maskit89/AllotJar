using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Accounts;
using AllotJar.Application.Jars;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.CreateTransfer;

public class CreateTransferCommandHandler : IRequestHandler<CreateTransferCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public CreateTransferCommandHandler(
        IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<TransactionDto> Handle(CreateTransferCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var from = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == request.FromAccountId, cancellationToken)
            ?? throw new NotFoundException($"Account {request.FromAccountId} was not found.");
        var to = await _db.Accounts.FirstOrDefaultAsync(a => a.Id == request.ToAccountId, cancellationToken)
            ?? throw new NotFoundException($"Account {request.ToAccountId} was not found.");

        if (from.OwnerId != userId || to.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Without a conversion the raw amount is debited from one account and credited
        // to the other, so a cross-currency transfer would silently change net worth
        // (e.g. £100 credited for €100 debited). Block it until real FX is recorded.
        if (from.Currency != to.Currency)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(request.ToAccountId)] = new[]
                {
                    "Both accounts must use the same currency to transfer between them.",
                },
            });
        }

        var transfer = new Transaction
        {
            OwnerId = userId,
            // The register's display date is the confirmed departure; each bank leg keeps its
            // own posting date below and the ledger never falls back to this field.
            Date = request.DepartedOn,
            DepartedOn = request.DepartedOn,
            ReceivedOn = request.ReceivedOn,
            Payee = string.IsNullOrWhiteSpace(request.Payee) ? "Transfer" : request.Payee.Trim(),
            Amount = request.Amount,
            // Both accounts share a currency (guarded above); stamp the transfer in it
            // rather than a hardcoded EUR so the register row matches the accounts.
            Currency = from.Currency,
            Type = TransactionType.Transfer,
            Account = from,
            AccountId = from.Id,
            TransferAccount = to,
            TransferAccountId = to.Id,
        };

        _db.Transactions.Add(transfer);

        // Both sides: the source is checked (rule 74) and the destination's jars are answered (P11).
        await using var write = await _db.BeginLedgerWriteAsync(new[] { from.Id, to.Id }, cancellationToken);
        var fee = await TransferFees.ApplyAsync(
            _db, _identity, userId, transfer, from, request.Fee, request.FeeBudgetItemId, request.AcknowledgeCrossMonth,
            request.FromJarId, nameof(request.Fee), new List<Guid>(), cancellationToken);

        // Rule 74 on the source: the departure (and its fee) must leave it at or above zero on every date.
        await AccountBalanceGuard.EnsureNonNegativeAsync(
            _db, new[] { from }, fee is null ? new[] { transfer } : new[] { transfer, fee }, Array.Empty<Guid>(), "Amount", cancellationToken);

        if (request.FromJarId is Guid fromJarId)
        {
            await JarMovements.ApplyOutgoingAsync(_db, userId, transfer, from, fromJarId, "FromJarId", cancellationToken);
            await JarHistoryChecks.EnsureTransferDrawAsync(_db, userId, transfer, from, fromJarId, "FromJarId", cancellationToken);
        }
        if (request.JarAllocations is { Count: > 0 })
        {
            await JarMovements.ApplyIncomingAsync(
                _db, userId, transfer, to, request.ReceivedOn ?? request.DepartedOn, request.Amount, request.JarAllocations,
                "JarAllocations", cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return transfer.JarAllocations.Count == 0 && fee is null
            ? transfer.ToDto()
            : await TransactionReads.ReadDtoAsync(_db, transfer.Id, cancellationToken);
    }
}
