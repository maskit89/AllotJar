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

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        var asOf = request.AsOf ?? today;

        // Rule 21: a Recurring cycle whose deadline has arrived with its target held rolls
        // forward the first time the jars are read after it (there is no scheduler); one that
        // was short stays open as Deadline missed (rule 20). Settlement is a write to the jar's
        // lifecycle, so it runs on the real date: an as-of read is a projection and must never
        // close a cycle whose deadline has not actually come.
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken);

        // A month that is over is history (rule 46): a jar archived since still had its line and
        // its money there, and the grid still shows that line, so the shelf shows the jar too.
        var monthStart = request.Month is { } m ? new DateOnly(m.Year, m.Month, 1) : new DateOnly(asOf.Year, asOf.Month, 1);
        var isOver = monthStart.AddMonths(1).AddDays(-1) < asOf;
        var year = monthStart.Year;
        var monthNumber = monthStart.Month;
        var jars = await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId
                        && (request.IncludeArchived || !f.IsArchived
                            || (isOver && _db.BudgetItems.Any(i => i.SavingsId == f.Id
                                                                  && i.BudgetCategory.BudgetMonth.OwnerId == userId
                                                                  && i.BudgetCategory.BudgetMonth.Year == year
                                                                  && i.BudgetCategory.BudgetMonth.Month == monthNumber))))
            .OrderBy(f => f.Name)
            .ToListAsync(cancellationToken);

        // W05 (rule 48): the figures of the selected month — a past month as of its end, the
        // current or a later month as of today — never today's all-time balance for history.
        return await JarFigures.ReadAsync(_db, userId, jars, asOf, cancellationToken, month: request.Month);
    }
}
