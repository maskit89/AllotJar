using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;

namespace AllotJar.Application.Budgets.Commands.SkipJarContribution;

public class SkipJarContributionCommandHandler : IRequestHandler<SkipJarContributionCommand, BudgetMonthDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public SkipJarContributionCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<BudgetMonthDto> Handle(SkipJarContributionCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var today = DateOnly.FromDateTime(DateTime.UtcNow);

        var (item, jar) = await JarLineLoader.LoadAsync(_db, userId, request.BudgetItemId, today, cancellationToken);

        // Rule 21: a funded cycle whose deadline has arrived rolls forward first, so the replant
        // below plans toward the cycle the jar is actually in.
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);

        item.IsSkipped = request.Skipped;
        // Skipping, or planning the month again, hands it back to the schedule (O3b).
        item.IsPlannedByHand = false;
        if (request.Skipped)
        {
            item.PlannedAmount = 0m;
        }
        // The other months carry the plan (rule 61), from the balance the jar actually holds; a
        // month planned again takes its share back.
        await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
        await _db.SaveChangesAsync(cancellationToken);

        var monthId = item.BudgetCategory.BudgetMonthId;
        var month = await _db.BudgetMonths
            .AsNoTracking()
            .Include(m => m.Categories)
                .ThenInclude(c => c.Items)
            .FirstAsync(m => m.Id == monthId, cancellationToken);

        await BudgetActuals.ApplyAsync(_db, userId, month, cancellationToken);

        return month.ToDto();
    }
}
