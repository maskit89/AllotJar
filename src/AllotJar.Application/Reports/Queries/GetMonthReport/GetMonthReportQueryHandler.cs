using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Dtos;

namespace AllotJar.Application.Reports.Queries.GetMonthReport;

public class GetMonthReportQueryHandler : IRequestHandler<GetMonthReportQuery, MonthReportDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMonthReportQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MonthReportDto> Handle(GetMonthReportQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        if (request.Month is < 1 or > 12)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Month"] = new[] { "Month must be between 1 and 12." },
            });
        }

        var budget = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstOrDefaultAsync(m => m.OwnerId == userId && m.Year == request.Year && m.Month == request.Month,
                cancellationToken);

        return await ReportFigures.ForMonthAsync(_db, userId, request.Year, request.Month, budget, cancellationToken);
    }
}
