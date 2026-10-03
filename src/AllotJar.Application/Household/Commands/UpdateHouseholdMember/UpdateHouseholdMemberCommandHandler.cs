using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Common;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Household.Commands.UpdateHouseholdMember;

public class UpdateHouseholdMemberCommandHandler
    : IRequestHandler<UpdateHouseholdMemberCommand, HouseholdMemberDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public UpdateHouseholdMemberCommandHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<HouseholdMemberDto> Handle(
        UpdateHouseholdMemberCommand request, CancellationToken cancellationToken)
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
        MoneyInput.EnsureAccepted((nameof(request.NetMonthlyIncome), request.NetMonthlyIncome, member.NetMonthlyIncome));
        _db.ExpectVersion(member, request.Version);

        // A personal-savings account must exist and belong to this household. It's a soft hint with
        // no FK, so validate here — otherwise a stale or foreign id would be stored and later booked
        // as an allocation transfer into a non-existent (crash) or another household's (leak) account.
        // An unchanged choice is kept as it is: it may be the person's own private account, which
        // someone else editing them cannot see (P53) and must not lose. Since the People list
        // withholds that account's id (P56), "none" from such an editor means "leave it": only a
        // login that can see the account clears it; anyone may still pick another visible one.
        var savingsAccountId = request.PersonalSavingsAccountId;
        if (savingsAccountId is null
            && await HiddenAccounts.IsHiddenAsync(_db, _currentUser.UserId, member.PersonalSavingsAccountId, cancellationToken))
        {
            savingsAccountId = member.PersonalSavingsAccountId;
        }
        if (savingsAccountId is Guid savingsId && savingsId != member.PersonalSavingsAccountId)
        {
            var owned = await _db.Accounts
                .AnyAsync(a => a.Id == savingsId && a.OwnerId == userId, cancellationToken);
            if (!owned)
            {
                throw new NotFoundException($"Account {savingsId} was not found.");
            }
            await HouseholdMemberGuards.EnsureNotAnAllocationSourceAsync(
                _db, userId, savingsId, cancellationToken);
        }

        var newName = request.Name.Trim();
        if (!string.Equals(member.Name, newName, StringComparison.Ordinal))
        {
            await RenamePocketMoneyLinesAsync(userId, member, newName, cancellationToken);
        }

        member.Name = newName;
        member.NetMonthlyIncome = request.NetMonthlyIncome;
        member.PersonalSavingsAccountId = savingsAccountId;

        await _db.SaveChangesAsync(cancellationToken);

        return await HouseholdMemberReads.ToDtoAsync(_db, _currentUser, userId, member, cancellationToken);
    }

    /// <summary>
    /// Rule 53: the pocket-money lines linked to the person (their id, not their name) show the
    /// new name in every month — the amounts and totals do not move. A line the user gave a name
    /// of their own (anything but the person's current name) keeps it.
    /// </summary>
    private async Task RenamePocketMoneyLinesAsync(
        string userId, HouseholdMember member, string newName, CancellationToken cancellationToken)
    {
        var lines = await _db.BudgetItems
            .Where(i => i.MemberId == member.Id
                        && i.BudgetCategory.Kind == CategoryKind.Expense
                        && i.BudgetCategory.BudgetMonth.OwnerId == userId)
            .ToListAsync(cancellationToken);
        foreach (var line in lines.Where(l => string.Equals(l.Name, member.Name, StringComparison.OrdinalIgnoreCase)))
        {
            line.Name = newName;
        }
    }
}
