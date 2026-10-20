using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Commands.EraseUnreachableAccount;

/// <summary>
/// Erases, unseen, a private account whose login has left the household (P59, Christopher's "Add"
/// and "Keep shared" of 30 September 2026; the erase itself is <see cref="PrivateAccountErase"/>).
/// Only what nobody else could see goes: the account, its
/// entries off the budget, and its movements with other accounts nobody can reach. What the
/// household already saw stays and keeps counting as it did: an entry on a budget line or a refund
/// of a shared purchase stays as an entry with no account (as DeleteAccount keeps them), and the
/// shared side of a posted transfer stays as a plain entry on the shared account, with its date,
/// amount, bank reference, jar postings and fee, so no household figure and no statement history
/// changes.
/// </summary>
public class EraseUnreachableAccountCommandHandler : IRequestHandler<EraseUnreachableAccountCommand>
{
    public const string ErasedSourcePayee = PrivateAccountErase.ErasedSourcePayee;
    public const string ErasedDestinationPayee = PrivateAccountErase.ErasedDestinationPayee;
    public const string ErasedReturnPayee = PrivateAccountErase.ErasedReturnPayee;

    private readonly IApplicationDbContext _db;
    private readonly IIdentityService _identity;
    private readonly ICurrentUser _currentUser;

    public EraseUnreachableAccountCommandHandler(IApplicationDbContext db, IIdentityService identity, ICurrentUser currentUser)
    {
        _db = db;
        _identity = identity;
        _currentUser = currentUser;
    }

    public async Task Handle(EraseUnreachableAccountCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Only an account nobody can reach: anything a login can still see is that login's to delete.
        var unreachable = await UnreachableAccounts.UnreachableIdsAsync(_db, _identity, ownerId, cancellationToken);
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

        await PrivateAccountErase.EraseAsync(_db, ownerId, account, unreachable, PrivateAccountErase.RefundedElsewhere.Refuse, cancellationToken);
    }

    private static ValidationException Refuse(string key, string message) =>
        new(new Dictionary<string, string[]> { [key] = new[] { message } });
}
