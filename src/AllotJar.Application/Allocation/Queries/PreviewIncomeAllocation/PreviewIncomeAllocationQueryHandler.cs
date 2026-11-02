using MediatR;
using AllotJar.Application.Allocation.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;

namespace AllotJar.Application.Allocation.Queries.PreviewIncomeAllocation;

public class PreviewIncomeAllocationQueryHandler
    : IRequestHandler<PreviewIncomeAllocationQuery, AllocationResultDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;
    private readonly TimeProvider _clock;

    public PreviewIncomeAllocationQueryHandler(IApplicationDbContext db, ICurrentUser currentUser, TimeProvider? clock = null)
    {
        _db = db;
        _currentUser = currentUser;
        _clock = clock ?? TimeProvider.System;
    }

    public async Task<AllocationResultDto> Handle(
        PreviewIncomeAllocationQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var plan = await AllocationPlanner.PlanAsync(
            _db, userId, request.Year, request.Month, request.ProfileId, cancellationToken,
            DateOnly.FromDateTime(_clock.GetUtcNow().UtcDateTime));

        return plan.Result.ToDto(
            plan.EnvelopesTotal, plan.JarsTotal,
            unattributedIncome: plan.UnattributedIncome, incomeFromBudget: plan.IncomeFromBudget,
            privateSavings: plan.PrivateSavings);
    }
}
