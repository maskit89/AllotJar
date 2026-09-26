using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

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

        // A transfer is one movement between two accounts with a bank leg on each side. Clearing
        // either side would leave a half-movement the dated ledger can no longer read, and would
        // discard that side's statement reference (rule 51). The user removes or re-records those
        // transfers first; nothing is silently detached.
        var transferCount = await _db.Transactions
            .CountAsync(t => t.Type == TransactionType.Transfer
                             && (t.AccountId == account.Id || t.TransferAccountId == account.Id),
                cancellationToken);
        if (transferCount > 0)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Id"] = new[]
                {
                    $"'{account.Name}' is a side of {transferCount} transfer{(transferCount == 1 ? "" : "s")}. " +
                    "Delete or re-record those transfers before deleting the account.",
                },
            });
        }

        // Unlink the account's other transactions explicitly so they survive the delete
        // (the register is the source of truth). This also keeps behaviour identical
        // across providers that don't enforce the FK's ON DELETE SET NULL.
        var linked = await _db.Transactions
            .Where(t => t.AccountId == account.Id)
            .ToListAsync(cancellationToken);
        foreach (var t in linked)
        {
            t.AccountId = null;
        }

        _db.Accounts.Remove(account);
        await _db.SaveChangesAsync(cancellationToken);
    }
}
