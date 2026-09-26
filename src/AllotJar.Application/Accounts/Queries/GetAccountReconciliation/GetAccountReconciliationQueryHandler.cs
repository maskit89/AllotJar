using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Dtos;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars;

namespace AllotJar.Application.Accounts.Queries.GetAccountReconciliation;

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

        var asOf = request.AsOf ?? DateOnly.FromDateTime(DateTime.UtcNow);
        var ledger = await AccountLedgerReader.ReadAsync(_db, userId, accounts, asOf, cancellationToken);

        // The jar side is actual money too (rules 1–6): each account's jars and unallocated
        // remainder reconcile to its balance by construction, and rule 70 flags any account
        // whose positive jars exceed its money.
        var jars = await JarLedgerReader.ReadAsync(_db, userId, asOf, cancellationToken);

        return accounts
            .Select(a =>
            {
                var view = ledger[a.Id];
                jars.Accounts.TryGetValue(a.Id, out var jarView);
                var backed = jars.Jars.Values.Where(j => j.FundingAccountId == a.Id && !j.IsArchived).ToList();
                return new AccountReconciliationDto
                {
                    AccountId = a.Id,
                    AccountName = a.Name,
                    CurrentBalance = view.Balance,
                    BackedJarsTotal = jarView?.IsAvailable == true
                        ? backed.Sum(j => jarView.JarBalances.TryGetValue(j.Id, out var b) ? b : 0m)
                        : 0m,
                    BackedJarCount = backed.Count,
                    Float = jarView is null ? view.Balance : jarView.Unallocated,
                    HasBackingDeficit = jarView?.HasBackingDeficit ?? false,
                    RequiresReview = view.RequiresReview,
                };
            })
            .ToList();
    }
}
