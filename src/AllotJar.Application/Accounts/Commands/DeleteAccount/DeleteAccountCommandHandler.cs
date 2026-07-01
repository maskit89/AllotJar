using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Commands.DeleteAccount;

public class DeleteAccountCommandHandler : IRequestHandler<DeleteAccountCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public DeleteAccountCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(DeleteAccountCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var account = await _db.Accounts
            .FirstOrDefaultAsync(a => a.Id == request.Id, cancellationToken);

        if (account is null)
        {
            throw new NotFoundException($"Account {request.Id} was not found.");
        }
        if (account.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Unlink the account's transactions explicitly so they survive the delete
        // (the register is the source of truth). This also keeps behaviour identical
        // across providers that don't enforce the FK's ON DELETE SET NULL.
        var linked = await _db.Transactions
            .Where(t => t.AccountId == account.Id)
            .ToListAsync(cancellationToken);
        foreach (var t in linked)
        {
            t.AccountId = null;
        }

        // Transfers into this account reference it via TransferAccountId (an FK with
        // Restrict, so it must be cleared before the account can be removed).
        var transfersIn = await _db.Transactions
            .Where(t => t.TransferAccountId == account.Id)
            .ToListAsync(cancellationToken);
        foreach (var t in transfersIn)
        {
            t.TransferAccountId = null;
        }

        _db.Accounts.Remove(account);
        await _db.SaveChangesAsync(cancellationToken);
    }
}
