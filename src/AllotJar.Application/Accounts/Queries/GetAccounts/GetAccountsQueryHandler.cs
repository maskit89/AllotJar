using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Accounts.Queries.GetAccounts;

public class GetAccountsQueryHandler : IRequestHandler<GetAccountsQuery, IReadOnlyList<AccountDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetAccountsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<AccountDto>> Handle(
        GetAccountsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var accounts = await _db.Accounts
            .AsNoTracking()
            .Where(a => a.OwnerId == userId)
            .OrderBy(a => a.DisplayOrder)
                .ThenBy(a => a.Name)
            .ToListAsync(cancellationToken);

        await AccountBalances.ApplyAsync(_db, userId, accounts, cancellationToken);

        return accounts.Select(a => a.ToDto()).ToList();
    }
}
