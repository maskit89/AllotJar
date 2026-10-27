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

        if (request.Month is < 1 or > 12 || request.Year is < 1900 or > 9998)
        {
            throw new ValidationException(new Dictionary<string, string[]>
            {
                ["Month"] = new[] { "Give a month between 1 and 12 of a year from 1900 to 9998." },
            });
        }

        var (carriedIn, month, inChain) = await MonthLeftover.WithCarryAsync(
            _db, userId, request.Year, request.Month, cancellationToken);
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        return new MonthWrapUpDto
        {
            Year = request.Year,
            Month = request.Month,
            CarriedIn = carriedIn,
            Received = month.Received,
            Spent = month.Spent,
            IntoJars = month.IntoJars,
            // A month before the first budget passes nothing on (it is outside the chain).
            LeftOver = inChain ? carriedIn + month.LeftOver : 0m,
            IsOver = new DateOnly(request.Year, request.Month, 1).AddMonths(1) <= today,
            FxPendingCount = month.FxPendingCount,
        };
    }
}
