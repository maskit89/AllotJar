using System.Globalization;
using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Entities;

namespace AllotJar.Application.Household.Commands.ArchiveHouseholdMember;

public class ArchiveHouseholdMemberCommandHandler
    : IRequestHandler<ArchiveHouseholdMemberCommand, HouseholdMemberDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public ArchiveHouseholdMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<HouseholdMemberDto> Handle(
        ArchiveHouseholdMemberCommand request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var member = await _db.HouseholdMembers
            .FirstOrDefaultAsync(m => m.Id == request.Id, cancellationToken)
            ?? throw new NotFoundException($"Household member {request.Id} was not found.");

        if (member.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        // Rule 54 runs once, on the transition into the archive: re-archiving an archived person
        // (or restoring one) changes no budget line.
        if (request.Archived && !member.IsArchived)
        {
            await StopPocketMoneyAsync(userId, member, request.PocketMoneyThisMonth, cancellationToken);
        }

        member.IsArchived = request.Archived;
        await _db.SaveChangesAsync(cancellationToken);

        return await HouseholdMemberReads.ToDtoAsync(_db, _currentUser, userId, member, cancellationToken);
    }

    /// <summary>
    /// Rule 54: the person's pocket-money lines in every month after the current one are cancelled
    /// (removed when nothing was recorded on them, otherwise reduced to what was paid); the current
    /// month's are kept or cancelled as the caller decided, and the archive is refused when that
    /// decision is missing while something is still planned. Past months are history and untouched.
    /// </summary>
    private async Task StopPocketMoneyAsync(
        string userId, HouseholdMember member, PocketMoneyDecision? decision, CancellationToken ct)
    {
        var (year, monthNo) = HouseholdMonth.Resolve(null, null);
        var months = await PocketMoneyLines.ReadFromAsync(_db, userId, member.Id, year, monthNo, ct);
        if (months.Count == 0)
        {
            return;
        }

        var current = months.FirstOrDefault(m => m.Year == year && m.Month == monthNo);
        if (current is { Remaining: > 0m } && decision is null)
        {
            var monthName = new DateTime(year, monthNo, 1).ToString("MMMM yyyy", CultureInfo.InvariantCulture);
            throw new ValidationException(new Dictionary<string, string[]>
            {
                [nameof(ArchiveHouseholdMemberCommand.PocketMoneyThisMonth)] = new[]
                {
                    $"{member.Name} still has {current.Remaining.ToString("0.00", CultureInfo.InvariantCulture)} of pocket money planned for {monthName}. Choose whether to keep or cancel it before archiving." +
                    (current.Waiting ? " A payment is waiting for its converted amount, so its line keeps its plan until the amount is confirmed." : string.Empty),
                },
            });
        }

        foreach (var pocket in months)
        {
            var isCurrent = pocket.Year == year && pocket.Month == monthNo;
            if (isCurrent && decision != PocketMoneyDecision.Cancel)
            {
                continue; // this month's plan stays; the stop starts next month
            }

            var tracked = await _db.BudgetMonths
                .Include(m => m.Categories)
                    .ThenInclude(c => c.Items)
                .FirstAsync(m => m.Id == pocket.MonthId, ct);
            var paid = pocket.Lines.ToDictionary(l => l.Id, l => l.Paid);
            await PocketMoneyLines.CancelAsync(_db, tracked, member.Id, paid, ct);
        }
    }
}
