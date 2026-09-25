using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Commands.CreateTransfer;

public class CreateTransferCommandHandler : IRequestHandler<CreateTransferCommand, TransactionDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CreateTransferCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
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
            ExchangeRate = 1m,
            Type = TransactionType.Transfer,
            Account = from,
            AccountId = from.Id,
            TransferAccount = to,
            TransferAccountId = to.Id,
        };

        _db.Transactions.Add(transfer);
        await _db.SaveChangesAsync(cancellationToken);

        return transfer.ToDto();
    }
}
