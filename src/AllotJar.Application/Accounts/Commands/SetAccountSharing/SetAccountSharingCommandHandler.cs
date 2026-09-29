using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Commands.SetAccountSharing;

public class SetAccountSharingCommandHandler : IRequestHandler<SetAccountSharingCommand, AccountDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SetAccountSharingCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<AccountDto> Handle(SetAccountSharingCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var account = await _db.Accounts
            .Include(a => a.Holders)
                .ThenInclude(h => h.Member)
            .FirstOrDefaultAsync(a => a.Id == request.AccountId && a.OwnerId == ownerId, cancellationToken)
            ?? throw new NotFoundException($"Account {request.AccountId} was not found.");

        var holders = account.Holders.Select(h => h.Member!).ToList();
        // Sharing a private account is always open to the login it is private to (the filter
        // shows it to no one else); making one private needs the caller's own personal account.
        var privateToCaller = await _db.AccountPrivacies.AnyAsync(p => p.AccountId == account.Id, cancellationToken);
        var ownPersonal = holders.Count == 1 && holders[0].Id == _currentUser.MemberId && _currentUser.UserId is not null;
        if (!ownPersonal && !(privateToCaller && !request.IsPrivate))
        {
            throw new ForbiddenAccessException(holders.Count == 1
                ? $"Only {holders[0].Name}'s own login can choose who sees this account."
                : "Only a personal account's holder can choose who sees it; joint and household accounts are visible to everyone.");
        }

        if (request.IsPrivate)
        {
            await AccountSharing.EnsureCanBePrivateAsync(_db, _currentUser, account, holders, "IsPrivate", cancellationToken);
        }
        await AccountSharing.SetPrivateAsync(_db, account, request.IsPrivate ? _currentUser.UserId : null, cancellationToken);
        await _db.SaveChangesAsync(cancellationToken);

        var asOf = DateOnly.FromDateTime(DateTime.UtcNow);
        var views = await AccountLedgerReader.ReadAsync(_db, ownerId, new[] { account }, asOf, cancellationToken);
        var dto = account.ToDto(views[account.Id]);
        await AccountSharing.DecorateAsync(_db, _currentUser, new[] { (account, dto) }, cancellationToken);
        return dto;
    }
}
