using MediatR;
using Microsoft.EntityFrameworkCore;
using ZeroBudget.Application.Accounts.Dtos;
using ZeroBudget.Application.Common.Exceptions;
using ZeroBudget.Application.Common.Interfaces;
using ZeroBudget.Application.Jars;

namespace ZeroBudget.Application.Accounts.Queries.GetAccountReconciliation;

public class GetAccountReconciliationQueryHandler
    : IRequestHandler<GetAccountReconciliationQuery, IReadOnlyList<AccountReconciliationDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetAccountReconciliationQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<AccountReconciliationDto>> Handle(
        GetAccountReconciliationQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var accounts = await _db.Accounts
            .AsNoTracking()
            .Where(a => a.OwnerId == userId)
            .OrderBy(a => a.DisplayOrder)
                .ThenBy(a => a.Name)
            .ToListAsync(cancellationToken);

        if (accounts.Count == 0)
        {
            return Array.Empty<AccountReconciliationDto>();
        }

        await AccountBalances.ApplyAsync(_db, userId, accounts, cancellationToken);

        var funds = await _db.Jars
            .AsNoTracking()
            .Where(f => f.OwnerId == userId && !f.IsArchived && f.FundingAccountId != null)
            .Select(f => new { f.Id, f.OpeningBalance, FundingAccountId = f.FundingAccountId!.Value })
            .ToListAsync(cancellationToken);

        var tracked = await JarBalances.ComputeAsync(_db, userId, cancellationToken);

        return accounts
            .Select(a =>
            {
                var backed = funds.Where(f => f.FundingAccountId == a.Id).ToList();
                var backedTotal = backed.Sum(f => f.OpeningBalance + tracked.GetValueOrDefault(f.Id));
                return new AccountReconciliationDto
                {
                    AccountId = a.Id,
                    AccountName = a.Name,
                    CurrentBalance = a.CurrentBalance,
                    BackedJarsTotal = backedTotal,
                    BackedJarCount = backed.Count,
                    Float = a.CurrentBalance - backedTotal,
                };
            })
            .ToList();
    }
}
