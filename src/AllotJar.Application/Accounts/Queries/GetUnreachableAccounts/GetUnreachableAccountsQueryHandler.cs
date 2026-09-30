using MediatR;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Queries.GetUnreachableAccounts;

public class GetUnreachableAccountsQueryHandler : IRequestHandler<GetUnreachableAccountsQuery, IReadOnlyList<UnreachableAccountDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetUnreachableAccountsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<UnreachableAccountDto>> Handle(GetUnreachableAccountsQuery request, CancellationToken cancellationToken)
    {
        var ownerId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        // Queries aren't role-gated by the pipeline; only the owner sees what nobody can reach.
        if (_currentUser.Role != HouseholdRole.Owner)
        {
            return Array.Empty<UnreachableAccountDto>();
        }
        return await UnreachableAccounts.ListAsync(_db, ownerId, cancellationToken);
    }
}
