using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Jars.Queries.GetJars;

public class GetJarsQueryHandler
    : IRequestHandler<GetJarsQuery, IReadOnlyList<JarDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<JarDto>> Handle(
        GetJarsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var asOf = request.AsOf ?? DateOnly.FromDateTime(DateTime.UtcNow);

        var jars = await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId && (request.IncludeArchived || !f.IsArchived))
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);

        if (jars.Count == 0)
        {
            return Array.Empty<JarDto>();
        }

        // Actual money only (rule 1): each jar's allocations in its account as of the date.
        var snapshot = await JarLedgerReader.ReadAsync(_db, userId, asOf, cancellationToken);
        return jars.Select(f => f.ToDto(snapshot)).ToList();
    }
}
