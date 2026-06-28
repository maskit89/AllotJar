using MediatR;
using Microsoft.EntityFrameworkCore;
using ZeroBudget.Application.Common.Exceptions;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Application.Jars.Dtos;
using ZeroBudget.Domain.Services;

namespace ZeroBudget.Application.Jars.Queries.GetJars;

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

        var funds = await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId && (request.IncludeArchived || !f.IsArchived))
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);

        if (funds.Count == 0)
        {
            return Array.Empty<JarDto>();
        }

        var tracked = await JarBalances.ComputeAsync(_db, userId, cancellationToken);

        return funds
            .Select(f =>
            {
                var balance = f.OpeningBalance + tracked.GetValueOrDefault(f.Id);
                var required = JarAccrualCalculator.RequiredMonthlyContribution(f, asOf, balance);
                return f.ToDto(balance, required, asOf);
            })
            .ToList();
    }
}
