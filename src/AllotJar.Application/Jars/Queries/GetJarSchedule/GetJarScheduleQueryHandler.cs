using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Queries.GetJarSchedule;

public class GetJarScheduleQueryHandler : IRequestHandler<GetJarScheduleQuery, JarScheduleDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarScheduleQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarScheduleDto> Handle(GetJarScheduleQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        // The definition being previewed, as the create/update handlers would store it. For an
        // edit it keeps the stored jar's identity and account so the ledger finds its balance.
        Jar? existing = null;
        if (request.JarId is { } id)
        {
            existing = await _db.Jars.AsNoTracking().FirstOrDefaultAsync(j => j.Id == id, cancellationToken)
                ?? throw new NotFoundException($"Jar {id} was not found.");
            if (existing.OwnerId != userId)
            {
                throw new ForbiddenAccessException();
            }
            // The preview of an edit starts from the cycle the jar is actually in (rule 21).
            if (await JarCycles.SettleOnReadAsync(_db, userId, today, cancellationToken, existing.Id))
            {
                existing = await _db.Jars.AsNoTracking().FirstAsync(j => j.Id == id, cancellationToken);
            }
        }
        var (anchor, cycleDeadline) = JarCycles.DeadlinesFor(existing, request.Kind, request.TargetDate);
        var jar = new Jar
        {
            Id = existing?.Id ?? Guid.NewGuid(),
            OwnerId = userId,
            Kind = request.Kind,
            TargetAmount = request.TargetAmount,
            TargetDate = anchor,
            CycleDeadline = cycleDeadline,
            Accrual = request.Accrual,
            MonthlyContribution = request.Accrual == AccrualMethod.FixedMonthly ? request.MonthlyContribution : null,
            IncludeDeadlineMonth = request.Accrual == AccrualMethod.TargetByDate && request.IncludeDeadlineMonth,
            RecurMonths = request.Kind == JarKind.Recurring ? request.RecurMonths ?? existing?.RecurMonths ?? 12 : null,
            FundingAccountId = existing?.FundingAccountId ?? Guid.Empty,
        };

        // An edit previews over the months the user has skipped (rule 60) and the later months
        // whose amount was typed by hand (O3b), exactly as saving it would replant them; a new jar
        // has none.
        var extra = existing is null ? request.InitialAllocation : 0m;
        var balances = await JarPlanner.BalancesAsync(_db, userId, jar, today, extra, cancellationToken);
        var skipped = existing is null
            ? new HashSet<DateOnly>()
            : await SavingsLines.SkippedMonthsAsync(_db, userId, jar.Id, today, cancellationToken);
        var byHand = existing is null
            ? null
            : (await SavingsLines.ByHandMonthsByJarAsync(_db, userId, new[] { jar.Id }, today, cancellationToken)).GetValueOrDefault(jar.Id);
        var plan = JarSchedule.Plan(jar, today, balances.Planning, new JarPlanOptions(skipped, balances.Now, ByHandMonths: byHand));
        return await JarScheduleDtos.BuildAsync(_db, userId, jar, plan, balances.Planning, cancellationToken);
    }
}
