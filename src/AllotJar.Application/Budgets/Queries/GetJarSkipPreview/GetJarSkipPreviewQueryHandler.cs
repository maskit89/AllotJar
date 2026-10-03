using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Dtos;

namespace AllotJar.Application.Budgets.Queries.GetJarSkipPreview;

public class GetJarSkipPreviewQueryHandler : IRequestHandler<GetJarSkipPreviewQuery, JarScheduleDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarSkipPreviewQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarScheduleDto> Handle(GetJarSkipPreviewQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        var (item, jar) = await JarLineLoader.LoadAsync(_db, userId, request.BudgetItemId, today, cancellationToken);
        // The preview plans toward the cycle the jar is actually in (rule 21).
        if (await JarCycles.SettleOnReadAsync(_db, userId, today, cancellationToken, jar.Id))
        {
            jar = await _db.Jars.AsNoTracking().FirstAsync(j => j.Id == jar.Id, cancellationToken);
        }

        var month = new DateOnly(item.BudgetCategory.BudgetMonth.Year, item.BudgetCategory.BudgetMonth.Month, 1);
        var balances = await JarPlanner.BalancesAsync(_db, userId, jar, today, 0m, cancellationToken);
        var plan = await JarPlanner.ScheduleAsync(_db, userId, jar, today, 0m, cancellationToken, alsoSkip: month);
        return await JarScheduleDtos.BuildAsync(_db, userId, jar, plan, balances.Planning, cancellationToken);
    }
}
