using MediatR;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Jars.Queries.GetJarPayments;

public class GetJarPaymentsQueryHandler : IRequestHandler<GetJarPaymentsQuery, IReadOnlyList<JarPaymentDto>>
{
    public const int MaxRows = 100;

    private readonly IApplicationDbContext _db;
    private readonly ICurrentUser _currentUser;

    public GetJarPaymentsQueryHandler(IApplicationDbContext db, ICurrentUser currentUser)
    {
        _db = db;
        _currentUser = currentUser;
    }

    public async Task<IReadOnlyList<JarPaymentDto>> Handle(GetJarPaymentsQuery request, CancellationToken cancellationToken)
    {
        var userId = _currentUser.OwnerId
            ?? throw new ForbiddenAccessException("No authenticated user on the request.");
        var jar = await _db.Jars.AsNoTracking().FirstOrDefaultAsync(j => j.Id == request.JarId, cancellationToken)
            ?? throw new NotFoundException($"Jar {request.JarId} was not found.");
        if (jar.OwnerId != userId)
        {
            throw new ForbiddenAccessException();
        }

        var today = request.AsOf ?? DateOnly.FromDateTime(DateTime.UtcNow);
        var jarId = jar.Id;
        var accountId = jar.FundingAccountId;
        var since = jar.FundingAccountSince;
        var fulfilled = await _db.JarCycles
            .Where(c => c.OwnerId == userId && c.PaymentTransactionId != null)
            .Select(c => c.PaymentTransactionId!.Value)
            .ToListAsync(cancellationToken);

        var query = _db.Transactions
            .AsNoTracking()
            .Where(t => t.OwnerId == userId
                        && t.Type == TransactionType.Expense
                        && t.RefundOfTransactionId == null
                        && t.Date <= today
                        && !fulfilled.Contains(t.Id))
            .Select(t => new
            {
                Transaction = t,
                AccountName = t.Account != null ? t.Account.Name : null,
                LineName = t.BudgetItem != null ? t.BudgetItem.Name : null,
                // Rule 79, as the ledger reads it: a payment from the jar's own account draws
                // from the jar through its stored answer when it has one, otherwise through its
                // Savings line (whole or a slice) when dated on or after the day the jar arrived
                // in that account (JarLedgerReader.HeldOn, P2-20).
                FromJar = t.AccountId == accountId
                          && (t.JarAllocations.Any(a => a.AccountId == accountId && a.Postings.Any(p => p.JarId == jarId && p.Amount < 0m))
                              || (!t.JarAllocations.Any(a => a.AccountId == accountId)
                                  && (since == null || t.Date >= since)
                                  && ((t.BudgetItem != null && t.BudgetItem.SavingsId == jarId)
                                      || t.Splits.Any(s => s.BudgetItem != null && s.BudgetItem.SavingsId == jarId)))),
            });
        if (!request.IncludeOtherPayments)
        {
            query = query.Where(x => x.FromJar);
        }

        var rows = await query
            .OrderByDescending(x => x.Transaction.Date)
            .ThenByDescending(x => x.Transaction.Amount)
            .Take(MaxRows)
            .ToListAsync(cancellationToken);

        return rows.Select(x => new JarPaymentDto
        {
            Id = x.Transaction.Id,
            Date = x.Transaction.Date,
            Payee = x.Transaction.Payee,
            Amount = x.Transaction.Amount,
            Currency = x.Transaction.Currency.Value,
            BaseAmount = x.Transaction.BaseAmount,
            FxPending = x.Transaction.FxPending,
            AccountId = x.Transaction.AccountId,
            AccountName = x.AccountName,
            BudgetItemName = x.LineName,
            FromJar = x.FromJar,
        }).ToList();
    }
}
