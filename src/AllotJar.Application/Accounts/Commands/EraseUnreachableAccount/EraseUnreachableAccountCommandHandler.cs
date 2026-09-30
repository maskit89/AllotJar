using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;

public class EraseUnreachableAccountCommandHandler : IRequestHandler<EraseUnreachableAccountCommand>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public EraseUnreachableAccountCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task Handle(EraseUnreachableAccountCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Only an account nobody can reach: anything a login can still see is that login's to delete.
        var unreachable = await UnreachableAccounts.UnreachableIdsAsync(_db, ownerId, cancellationToken);
        var account = unreachable.Contains(request.Id)
            ? await _db.Accounts.IgnoreQueryFilters().FirstOrDefaultAsync(a => a.Id == request.Id && a.OwnerId == ownerId, cancellationToken)
            : null;
        if (account is null)
        {
            throw new NotFoundException($"Account {request.Id} was not found among the accounts nobody can reach.");
        }
        if (!string.Equals(request.ConfirmName.Trim(), account.Name.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            throw Refuse("ConfirmName", "The name you typed doesn't match the account's name. Type it exactly to erase the account.");
        }

        // Everything that moves money in the account: its own rows, every transfer touching it
        // and their fee rows. A transfer's other side is a shared account, whose history loses
        // that movement; its jar postings there are cleared through the one writer that keeps a
        // departed jar's history balanced, as deleting the transfer by hand would.
        var rows = await _db.Transactions.IgnoreQueryFilters()
            .Include(t => t.Fee)
            .Include(t => t.Splits)
            .Where(t => t.OwnerId == ownerId
                        && (t.AccountId == account.Id
                            || (t.Type == TransactionType.Transfer && t.TransferAccountId == account.Id)
                            || (t.FeeForTransfer != null && t.FeeForTransfer.TransferAccountId == account.Id)))
            .ToListAsync(cancellationToken);
        var rowIds = rows.Select(t => t.Id).ToHashSet();

        // Rule 38: a refund elsewhere that names a purchase here would point nowhere and read as
        // income; the owner unlinks it where they can see it first.
        var refundsElsewhere = await _db.Transactions.IgnoreQueryFilters()
            .CountAsync(t => t.RefundOfTransactionId != null && rowIds.Contains(t.RefundOfTransactionId.Value) && !rowIds.Contains(t.Id), cancellationToken);
        if (refundsElsewhere > 0)
        {
            throw Refuse("Id",
                $"{refundsElsewhere} refund{(refundsElsewhere == 1 ? "" : "s")} in another account {(refundsElsewhere == 1 ? "is" : "are")} linked to a purchase in '{account.Name}'. " +
                "Unlink or delete them on the Transactions page first.");
        }

        _db.AllowErasing(account.Id);

        // Rule 74: the shared side of a transfer must stay at or above zero on every date without it.
        var otherIds = rows.Where(t => t.Type == TransactionType.Transfer)
            .SelectMany(t => new[] { t.AccountId, t.TransferAccountId })
            .Where(id => id is not null && id != account.Id)
            .Select(id => id!.Value)
            .Distinct()
            .ToList();
        var others = await _db.Accounts.Where(a => otherIds.Contains(a.Id)).ToListAsync(cancellationToken);
        await using var write = others.Count == 0 ? null : await _db.BeginLedgerWriteAsync(others.Select(a => a.Id), cancellationToken);
        await AccountBalanceGuard.EnsureNonNegativeAsync(_db, others, Array.Empty<Transaction>(), rowIds.ToList(), "Id", cancellationToken);

        foreach (var row in rows)
        {
            foreach (var other in others.Where(o => o.Id == row.AccountId || o.Id == row.TransferAccountId))
            {
                await JarMovements.ClearAsync(_db, row, other.Id, cancellationToken);
            }
            await TransferReturns.ClearAsync(_db, row.Id, cancellationToken);
        }
        // The account's own jar history can't exist (rule 33: a private account holds no jar), so
        // its remaining allocations, if any, are removed with it rather than left dangling.
        var allocations = await _db.JarAllocations.Include(a => a.Postings)
            .Where(a => a.AccountId == account.Id || (a.TransactionId != null && rowIds.Contains(a.TransactionId.Value)))
            .ToListAsync(cancellationToken);
        _db.JarAllocations.RemoveRange(allocations);
        // Fee rows go before their transfers (the link restricts the delete).
        _db.Transactions.RemoveRange(rows.Where(t => t.FeeForTransferId is not null));
        _db.Transactions.RemoveRange(rows.Where(t => t.FeeForTransferId is null));
        // Its holders and privacy row go with it (explicitly, so every provider agrees).
        _db.AccountHolders.RemoveRange(await _db.AccountHolders.Where(h => h.AccountId == account.Id).ToListAsync(cancellationToken));
        _db.AccountPrivacies.RemoveRange(await _db.AccountPrivacies.Where(p => p.AccountId == account.Id).ToListAsync(cancellationToken));
        _db.Accounts.Remove(account);
        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }
    }

    private static ValidationException Refuse(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
