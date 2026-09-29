using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions.Queries.GetTransactions;

public class GetTransactionsQueryHandler
    : IRequestHandler<GetTransactionsQuery, IReadOnlyList<TransactionDto>>
{
    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetTransactionsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<TransactionDto>> Handle(
        GetTransactionsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");

        var query = _db.Transactions
            .AsNoTracking()
            .Include(t => t.BudgetItem)
                // ThenInclude off the nullable BudgetItem nav: the expression is a navigation
                // path EF never invokes, so null-forgive to keep the reference-type flow clean.
                .ThenInclude(i => i!.BudgetCategory)
                .ThenInclude(c => c.BudgetMonth)
            .Include(t => t.Account)
            .Include(t => t.TransferAccount)
            .Include(t => t.Member)
            .Include(t => t.Splits)
                .ThenInclude(s => s.BudgetItem)
            .Include(t => t.Splits)
                .ThenInclude(s => s.Member)
            .Include(t => t.JarAllocations)
                .ThenInclude(a => a.Postings)
                .ThenInclude(p => p.Jar)
            .Include(t => t.RefundOf)
            .Include(t => t.Refunds)
            .Include(t => t.Fee)
                .ThenInclude(f => f!.BudgetItem)
            .Where(t => t.OwnerId == userId);

        if (request.Year is int year)
        {
            query = query.Where(t => t.Date.Year == year);
        }
        if (request.Month is int month)
        {
            query = query.Where(t => t.Date.Month == month);
        }
        if (request.UnassignedOnly)
        {
            query = query.Where(t => t.BudgetItemId == null);
        }

        var transactions = await query
            .OrderByDescending(t => t.Date)
            .ThenByDescending(t => t.Id)
            .ToListAsync(cancellationToken);

        return transactions.Select(t => t.ToDto()).ToList();
    }
}
