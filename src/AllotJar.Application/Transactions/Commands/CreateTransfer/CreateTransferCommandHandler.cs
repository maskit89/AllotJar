using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

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

        var transfer = new Transaction
        {
            OwnerId = userId,
            Date = request.Date,
            Payee = string.IsNullOrWhiteSpace(request.Payee) ? "Transfer" : request.Payee.Trim(),
            Amount = request.Amount,
            Currency = CurrencyCode.Eur,
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
