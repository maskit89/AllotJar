using MediatR;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Queries.GetMonthWrapUp;

public class GetMonthWrapUpQueryHandler : IRequestHandler<GetMonthWrapUpQuery, MonthWrapUpDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMonthWrapUpQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MonthWrapUpDto> Handle(GetMonthWrapUpQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        if (request.Month is < 1 or > 12 || request.Year is < 1 or > 9998)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Month"] = new[] { "Give a month between 1 and 12 of a year from 1 to 9998." },
            });
        }

        var carriedIn = await MonthLeftover.CarriedIntoAsync(_db, userId, request.Year, request.Month, cancellationToken);
        var month = await MonthLeftover.BetweenAsync(
            _db, userId, (request.Year, request.Month), (request.Year, request.Month), cancellationToken);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        return new MonthWrapUpDto
        {
            Year = request.Year,
            Month = request.Month,
            CarriedIn = carriedIn,
            Received = month.Received,
            Spent = month.Spent,
            IntoJars = month.IntoJars,
            LeftOver = carriedIn + month.LeftOver,
            IsOver = new DateOnly(request.Year, request.Month, 1).AddMonths(1) <= today,
            FxPendingCount = month.FxPendingCount,
        };
    }
}
