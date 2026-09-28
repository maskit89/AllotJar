using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Jars.Commands.UpdateJar;

public class UpdateJarCommandHandler
    : IRequestHandler<UpdateJarCommand, JarDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<JarDto> Handle(
        UpdateJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var jar = await _db.Jars
            .FirstOrDefaultAsync(f => f.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.Id} was not found.");

        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // A funded cycle whose deadline has arrived rolls forward before the edit is compared
        // (rule 21), so an edit never re-plants toward a cycle that is already over.
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);

        if (request.FundingAccountId != jar.FundingAccountId)
        {
            // Rule 80: the account can change only while the jar holds nothing; a field change
            // never moves money. Anything else goes through "Move money" (a confirmed transfer).
            var account = await JarAccounts.LoadDesignatedAsync(_db, userId, request.FundingAccountId, "FundingAccountId", cancellationToken);
            var current = await JarLedgerReader.ReadAsync(_db, userId, today, cancellationToken);
            var balance = current.BalanceOf(jar.Id);
            if (balance is null)
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name}'s balance is not available today, so its account cannot be changed.");
            }
            if (balance != 0m)
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name} holds {balance:0.##} in {current.AccountOf(jar.Id)?.Account.Name}. " +
                    "Move that money first (a transfer to the new account, or a reallocation to another jar), then change the account.");
            }
            if (await JarDepartures.HasUnpostedLegAsync(_db, jar.Id, jar.FundingAccountId, cancellationToken))
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name} has a transfer in transit in {current.AccountOf(jar.Id)?.Account.Name}. Confirm it first, then change the account.");
            }
            // The account it leaves keeps its history exactly as it reads today: the payments the
            // jar's lines drew from it are written down there before the jar names another account,
            // and the day it left is recorded so later corrections stay balanced there.
            var kept = await JarMovements.KeepLineAttributionAsync(_db, userId, jar, today, cancellationToken);
            await JarDepartures.RecordAsync(_db, userId, jar.Id, jar.FundingAccountId, today, kept > 0, cancellationToken);
            jar.FundingAccountId = account.Id;
        }

        if (jar.IsCompleted && request.Kind == JarKind.Recurring)
        {
            // Rule 55: a completed goal is done; turning it into a recurring jar would restart
            // contributions through the back door (reopening stays open — HANDOVER O3).
            throw JarAccounts.Validation("Kind", $"{jar.Name} is completed. A completed goal cannot become a recurring jar.");
        }

        var before = ScheduleInputs(jar);
        var replaced = JarRevision.Of(jar, today);
        // A Recurring jar's form shows its open cycle's date: sent back unchanged it keeps the
        // anchor and the cycle; any other date is a deliberate change and restarts both (W03).
        var (anchor, cycleDeadline) = JarCycles.DeadlinesFor(jar, request.Kind, request.TargetDate);
        jar.Name = request.Name.Trim();
        jar.Kind = request.Kind;
        jar.TargetAmount = request.TargetAmount;
        jar.TargetDate = anchor;
        jar.CycleDeadline = cycleDeadline;
        jar.Accrual = request.Accrual;
        jar.MonthlyContribution = request.Accrual == AccrualMethod.FixedMonthly ? request.MonthlyContribution : null;
        jar.IncludeDeadlineMonth = request.Accrual == AccrualMethod.TargetByDate && request.IncludeDeadlineMonth;
        // Recurring jars carry their cycle length; Goals never roll. Fall back to the
        // stored cycle (then yearly) when a request omits it, so an older/stale client
        // that doesn't send recurMonths can't silently reset a chosen 3/6-month cycle.
        jar.RecurMonths = request.Kind == JarKind.Recurring
            ? request.RecurMonths ?? jar.RecurMonths ?? 12
            : null;

        // Rule 46: a changed target, deadline or plan revises this month's and later months'
        // planned contributions — the schedule the form previewed before the user confirmed.
        // Past months, actual transactions and balances are untouched; a plain rename or a
        // change of account leaves every plan as it is. An archived or completed jar plans
        // nothing (rules 27, 55).
        var redefined = ScheduleInputs(jar) != before;
        if (redefined)
        {
            // P49: a month that is over keeps the definition it had at its end.
            await JarHistory.RecordEditAsync(_db, jar, replaced, today, cancellationToken);
        }
        if (JarSchedule.IsPlanning(jar) && redefined)
        {
            await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken);
        }

        await _db.SaveChangesAsync(cancellationToken);

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }

    private static (JarKind, decimal, DateOnly?, DateOnly?, AccrualMethod, decimal?, bool, int?) ScheduleInputs(Domain.Entities.Jar jar) =>
        (jar.Kind, jar.TargetAmount, jar.TargetDate, jar.CycleDeadline, jar.Accrual, jar.MonthlyContribution, jar.IncludeDeadlineMonth, jar.RecurMonths);
}
