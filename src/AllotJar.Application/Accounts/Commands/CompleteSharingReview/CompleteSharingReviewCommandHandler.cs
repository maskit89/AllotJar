using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Commands.CompleteSharingReview;

public class CompleteSharingReviewCommandHandler : IRequestHandler<CompleteSharingReviewCommand, SharingReviewDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public CompleteSharingReviewCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<SharingReviewDto> Handle(CompleteSharingReviewCommand request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var userId = _currentUser.UserId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var accounts = await SharingReview.PersonalAccountsAsync(_db, _currentUser, ownerId, cancellationToken);
        var unknown = request.PrivateAccountIds.FirstOrDefault(id => accounts.All(a => a.Id != id));
        if (unknown != Guid.Empty)
        {
            throw new NotFoundException($"Account {unknown} is not one of your personal accounts.");
        }

        foreach (var account in accounts)
        {
            var makePrivate = request.PrivateAccountIds.Contains(account.Id);
            if (makePrivate)
            {
                var holders = account.Holders.Select(h => h.Member!).ToList();
                await AccountSharing.EnsureCanBePrivateAsync(_db, _currentUser, account, holders, "PrivateAccountIds", cancellationToken);
            }
            await AccountSharing.SetPrivateAsync(_db, account, makePrivate ? userId : null, cancellationToken);
        }

        var membership = await _db.HouseholdMemberships
            .FirstOrDefaultAsync(m => m.OwnerId == ownerId && m.UserId == userId, cancellationToken);
        if (membership is not null)
        {
            membership.SharingReviewPending = false;
        }
        await _db.SaveChangesAsync(cancellationToken);

        return await SharingReview.ReadAsync(_db, _currentUser, cancellationToken);
    }
}
