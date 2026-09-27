using MediatR;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Queries.GetJarLedger;

public class GetJarLedgerQueryHandler : IRequestHandler<GetJarLedgerQuery, IReadOnlyList<JarAccountLedgerDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarLedgerQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<JarAccountLedgerDto>> Handle(GetJarLedgerQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var asOf = request.AsOf ?? DateOnly.FromDateTime(DateTime.UtcNow);
        var snapshot = await JarLedgerReader.ReadAsync(
            _db, userId, asOf, cancellationToken, request.AccountId is Guid id ? new[] { id } : null);
        return snapshot.Accounts.Values
            .OrderBy(v => v.Account.DisplayOrder).ThenBy(v => v.Account.Name)
            .Select(v => v.ToDto(snapshot))
            .ToList();
    }
}
