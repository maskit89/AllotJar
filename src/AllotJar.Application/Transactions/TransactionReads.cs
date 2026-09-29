using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Transactions.Dtos;

namespace AllotJar.Application.Transactions;

/// <summary>Re-reads one saved transaction with every navigation the DTO names, so each write path returns the same shape as the list.</summary>
public static class TransactionReads
{
    public static async Task<TransactionDto> ReadDtoAsync(IApplicationDbContext db, Guid id, CancellationToken cancellationToken)
    {
        var saved = await db.Transactions
            .AsNoTracking()
            .Include(t => t.BudgetItem)
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
            .FirstAsync(t => t.Id == id, cancellationToken);
        return saved.ToDto();
    }
}
