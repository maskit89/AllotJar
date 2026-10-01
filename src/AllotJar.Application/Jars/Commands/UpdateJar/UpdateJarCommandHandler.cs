using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common;
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
    private readonly IIdentityService? _identity;

    public UpdateJarCommandHandler(IApplicationDbContext db, ICurrentUser currentUser, IIdentityService? identity = null)
    {
        _db = db;
        _currentUser = currentUser;
        _identity = identity;
    }

    public async Task<JarDto> Handle(
        UpdateJarCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        // Under the ledger lock of the jar's account and of the account it may move to (P11): a
        // reallocation or payment into the jar either lands before the zero check below, or waits
        // and then finds the jar in its new account (JL-P2-5). Both are locked here, in id order,
        // so the save's own lock on the new account (P55) is already held.
        var (jar, write) = await JarLocks.LoadLockedAsync(_db, request.Id, request.FundingAccountId, cancellationToken);
        await using var _ = write;

        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }
        MoneyInput.EnsureAccepted(
            (nameof(request.TargetAmount), request.TargetAmount, jar.TargetAmount),
            (nameof(request.MonthlyContribution), request.MonthlyContribution, jar.MonthlyContribution));
        // On the jar as loaded under the lock: that is the entity this save writes (D11).
        _db.ExpectVersion(jar, request.Version);

        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        // A funded cycle whose deadline has arrived rolls forward before the edit is compared
        // (rule 21), so an edit never re-plants toward a cycle that is already over.
        await JarCycles.SettleAsync(_db, userId, today, cancellationToken, jar.Id);
        // The ledger as it stands before the edit, loaded once for the zero check and the replant:
        // an edit moves no money, and what it writes down keeps every balance as it reads (P3-10).
        var ledger = await JarLedgerReader.LoadAsync(_db, userId, cancellationToken);

        // A Recurring date changed to a deadline this jar already has a recorded cycle for (missed,
        // paid or rolled over) would open that cycle a second time, and closing it again could
        // never be recorded: the date is refused before anything is written (review round 1, P2-3).
        if (JarCycles.DeadlinesFor(jar, request.Kind, request.TargetDate).CycleDeadline is { } newDeadline
            && newDeadline != jar.CycleDeadline
            && await _db.JarCycles.AnyAsync(c => c.JarId == jar.Id && c.Deadline == newDeadline, cancellationToken))
        {
            throw JarAccounts.Validation(nameof(UpdateJarCommand.TargetDate),
                $"A cycle due on {newDeadline:d MMM yyyy} is already recorded for {jar.Name}. Pick another date.");
        }

        if (request.FundingAccountId != jar.FundingAccountId)
        {
            // Rule 80: the account can change only while the jar holds nothing, today and on every
            // later date its old account has an entry for; a field change never moves money.
            // Anything else goes through "Move money" (a confirmed transfer).
            var account = await JarAccounts.LoadDesignatedAsync(_db, userId, request.FundingAccountId, "FundingAccountId", cancellationToken, _identity);
            var current = ledger.At(today);
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
            if (await JarDepartures.HasUnpostedLegAsync(_db, jar.Id, cancellationToken))
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name} has a transfer in transit. Confirm it first, then change the account.");
            }
            if (await JarDepartures.EntryDatedAfterAsync(_db, userId, jar.Id, jar.FundingAccountId, today, cancellationToken) is { } later)
            {
                throw JarAccounts.Validation("FundingAccountId",
                    $"{jar.Name} has an entry dated {later:d MMM yyyy} in {current.AccountOf(jar.Id)?.Account.Name}. " +
                    "Change or remove it first, then change the account.");
            }
            // The account it leaves keeps its history exactly as it reads today: the payments the
            // jar's lines drew from it are written down there before the jar names another account,
            // and the day it left is recorded so later corrections stay balanced there.
            await JarAccounts.EnsureVisibleForJarAsync(_db, account, request.ShareAccount, cancellationToken);
            var kept = await JarMovements.KeepLineAttributionAsync(_db, userId, jar, today, cancellationToken);
            await JarDepartures.RecordAsync(_db, userId, jar.Id, jar.FundingAccountId, today, kept > 0, cancellationToken);
            // The account it joins keeps its history too: its payments on the jar's lines dated up
            // to today were made while the jar was held elsewhere, so they stay on its unallocated
            // money. From today, a payment on the jar's line from the new account draws from the
            // jar, and one dated before today is refused (P2-20).
            await JarMovements.KeepArrivalAttributionAsync(_db, userId, jar, account, today, cancellationToken);
            jar.FundingAccountId = account.Id;
            jar.FundingAccountSince = today;
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
        if (jar is { Kind: JarKind.Recurring, IsArchived: false, CycleDeadline: { } open } && open <= today && cycleDeadline != open)
        {
            // The open cycle is in Deadline missed (the settle above rolled it forward otherwise),
            // and the edit replaces it: it is recorded first, as Dismiss would close it now (Missed,
            // or FundedLate once the jar holds its target), so the history keeps it (rule 20, D15);
            // its balance is read the day before the deadline, as the rollover reads it.
            _db.JarCycles.Add(new JarCycle
            {
                OwnerId = userId,
                JarId = jar.Id,
                Deadline = open,
                TargetAmount = jar.TargetAmount,
                Outcome = JarCycles.UnpaidCloseOutcome(jar, ledger.At(today).BalanceOf(jar.Id)),
                BalanceAtDeadline = ledger.At(open.AddDays(-1)).BalanceOf(jar.Id),
                ClosedOn = today,
                CreatedUtc = DateTime.UtcNow,
            });
        }
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
            await JarPlanner.ReplantAsync(_db, userId, jar, today, 0m, cancellationToken, ledger);
        }

        await _db.SaveChangesAsync(cancellationToken);
        if (write is not null)
        {
            await write.CommitAsync(cancellationToken);
        }

        return await JarFigures.ReadOneAsync(_db, userId, jar, today, cancellationToken);
    }

    private static (JarKind, decimal, DateOnly?, DateOnly?, AccrualMethod, decimal?, bool, int?) ScheduleInputs(Domain.Entities.Jar jar) =>
        (jar.Kind, jar.TargetAmount, jar.TargetDate, jar.CycleDeadline, jar.Accrual, jar.MonthlyContribution, jar.IncludeDeadlineMonth, jar.RecurMonths);
}
