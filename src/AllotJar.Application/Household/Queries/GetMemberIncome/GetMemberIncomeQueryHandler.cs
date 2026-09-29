using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Allocation;
using AllotJar.Application.Household.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Household.Queries.GetMemberIncome;

public class GetMemberIncomeQueryHandler : IRequestHandler<GetMemberIncomeQuery, MemberIncomeResultDto>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetMemberIncomeQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<MemberIncomeResultDto> Handle(GetMemberIncomeQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var members = await _db.HouseholdMembers
            .AsNoTracking()
            .Where(m => m.OwnerId == userId && !m.IsArchived)
            .OrderBy(m => m.DisplayOrder)
                .ThenBy(m => m.Name)
            .ToListAsync(cancellationToken);

        if (members.Count == 0)
        {
            return new MemberIncomeResultDto();
        }

        var memberIds = members.Select(m => m.Id).ToList();

        // Planned side: the same derivation the allocation engine uses (rule 28).
        var planned = await MemberIncome.ForMonthAsync(
            _db, userId, request.Year, request.Month, memberIds, cancellationToken);
        var shares = await MemberIncome.SharesAsync(_db, userId, request.Year, request.Month, members, cancellationToken);

        // Received side: income transactions dated in the month, attributed whole or by
        // slice — a split counts by its slices only (it has no whole-tx attribution). A refund
        // is money back from a purchase, never income (rule 41).
        var from = new DateOnly(request.Year, request.Month, 1);
        var to = from.AddMonths(1);
        var incomes = await _db.Transactions
            .AsNoTracking()
            .Include(t => t.Splits)
            .Where(HouseholdMoney.Counts(_db))
            .Where(t => t.OwnerId == userId && t.Type == TransactionType.Income
                        && t.RefundOfTransactionId == null
                        && t.Date >= from && t.Date < to)
            .ToListAsync(cancellationToken);

        // Budget-currency amounts, like the budget grid; a row still waiting for its
        // budget-currency amount is counted separately, never at face value (rules 42–44).
        var memberIdSet = memberIds.ToHashSet();
        var privateAccounts = await HouseholdMoney.PrivateAccountIdsAsync(_db, incomes, cancellationToken);
        var receivedByMember = new Dictionary<Guid, decimal>();
        var fxPending = 0;
        foreach (var t in incomes)
        {
            if (t.FxPending)
            {
                fxPending++;
                continue;
            }
            if (t.Splits.Count > 0)
            {
                foreach (var slice in t.Splits.Where(slice => HouseholdMoney.SliceCounts(t, slice, privateAccounts)))
                {
                    if (slice.MemberId is Guid sliceMember && memberIdSet.Contains(sliceMember))
                    {
                        receivedByMember[sliceMember] = receivedByMember.GetValueOrDefault(sliceMember) + (slice.BudgetAmount ?? slice.Amount);
                    }
                }
            }
            else if (t.MemberId is Guid wholeMember && memberIdSet.Contains(wholeMember))
            {
                receivedByMember[wholeMember] = receivedByMember.GetValueOrDefault(wholeMember) + (t.BudgetAmount ?? t.Amount);
            }
        }

        return new MemberIncomeResultDto
        {
            IncomeFromBudget = true,
            HasBudget = planned.HasBudget,
            FxPendingCount = fxPending,
            UnattributedPlanned = planned.Unattributed,
            Items = members
                .Select(m => new MemberIncomeDto
                {
                    MemberId = m.Id,
                    Name = m.Name,
                    Planned = planned.ByMember.GetValueOrDefault(m.Id),
                    Received = receivedByMember.GetValueOrDefault(m.Id),
                    Income = shares.Income.GetValueOrDefault(m.Id),
                    SharePct = shares.ShareOf(m.Id),
                })
                .ToList(),
        };
    }
}
