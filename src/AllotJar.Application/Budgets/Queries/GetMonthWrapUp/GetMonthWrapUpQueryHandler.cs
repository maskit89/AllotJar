using MediatR;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Budgets.Queries.GetMonthWrapUp;

public class GetMonthWrapUpQueryHandler : IRequestHandler<GetMonthWrapUpQuery, MonthWrapUpDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly IIdentityService? _identity;

    public GetMonthWrapUpQueryHandler(IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
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

        var currency = await BudgetCurrency.ResolveAsync(_db, _identity, userId, cancellationToken);
        var chain = await MonthLeftover.ReadAsync(_db, userId, currency, cancellationToken);
        var month = chain.Of(request.Year, request.Month);
        var carriedIn = chain.CarriedInto(request.Year, request.Month);
        var waiting = await BudgetActuals.FxPendingCountsAsync(
            _db, userId, new[] { (request.Year, request.Month) }, cancellationToken);

        return new MonthWrapUpDto
        {
            Year = request.Year,
            Month = request.Month,
            CarriedIn = carriedIn,
            NewAccounts = month.NewAccounts,
            Received = month.Received,
            Spent = month.Spent,
            IntoJars = month.IntoJars,
            SetAside = month.SetAside,
            PrivateTransfers = month.PrivateTransfers,
            LeftOver = carriedIn + month.LeftOver,
            ToAllot = carriedIn + month.OutsidePlan,
            FxPendingCount = waiting.GetValueOrDefault((request.Year, request.Month)),
        };
    }
}
