using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Services;

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
        if (isOver && !request.IncludeArchived)
        {
            // A jar restored since, but archived all through the month's end with no line there,
            // was not on that month's shelf: restoring it does not add it after the fact (P2-19).
            var monthEnd = monthStart.AddMonths(1).AddDays(-1);
            var periods = await JarFigures.ArchivePeriodsAsync(_db, jars.Select(j => j.Id).ToList(), cancellationToken);
            var lined = await _db.BudgetItems
                .AsNoTracking()
                .Where(i => i.SavingsId != null
                            && i.BudgetCategory.BudgetMonth.OwnerId == userId
                            && i.BudgetCategory.BudgetMonth.Year == year
                            && i.BudgetCategory.BudgetMonth.Month == monthNumber)
                .Select(i => i.SavingsId!.Value)
                .ToListAsync(cancellationToken);
            jars = jars
                .Where(j => lined.Contains(j.Id) || !JarSchedule.IsArchivedOn(JarHistory.ArchiveOn(j, periods.GetValueOrDefault(j.Id), monthEnd), monthEnd))
                .ToList();
        }

        // W05 (rule 48): the figures of the selected month — a past month as of its end, the
        // current or a later month as of today — never today's all-time balance for history.
        return await JarFigures.ReadAsync(_db, userId, jars, asOf, cancellationToken, month: request.Month);
    }
}
