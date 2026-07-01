using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts;

/// <summary>
/// Derives each account's <see cref="Account.CurrentBalance"/> at read time:
/// the <see cref="Account.OpeningBalance"/> plus the net of every transaction
/// assigned to it (income adds, expense subtracts), in the account's own currency.
/// The transaction register therefore stays the single source of truth — there is no
/// stored balance to drift. Splitting a transaction doesn't change which account the
/// money moved in, so the whole transaction amount counts (slices are budget-line
/// attribution only).
/// </summary>
public static class AccountBalances
{
    public static async Task ApplyAsync(
        IApplicationDbContext db,
        string ownerId,
        IReadOnlyList<Account> accounts,
        CancellationToken cancellationToken)
    {
        if (accounts.Count == 0)
        {
            return;
        }

        var accountIds = accounts.Select(a => a.Id).ToList();

        // Income/expense legs: net movement per account (+ income, − expense).
        var nets = (await db.Transactions
            .Where(t => t.OwnerId == ownerId
                        && t.AccountId != null
                        && (t.Type == TransactionType.Income || t.Type == TransactionType.Expense)
                        && accountIds.Contains(t.AccountId.Value))
            .GroupBy(t => new { AccountId = t.AccountId!.Value, t.Type })
            .Select(g => new { g.Key.AccountId, g.Key.Type, Total = g.Sum(t => t.Amount) })
            .ToListAsync(cancellationToken))
            .ToList();

        // Transfers move money between two of the user's accounts: out of the source
        // (AccountId), into the destination (TransferAccountId). Not income or expense.
        var transfers = await db.Transactions
            .Where(t => t.OwnerId == ownerId && t.Type == TransactionType.Transfer)
            .Select(t => new { t.AccountId, t.TransferAccountId, t.Amount })
            .ToListAsync(cancellationToken);

        foreach (var account in accounts)
        {
            var income = nets
                .Where(n => n.AccountId == account.Id && n.Type == TransactionType.Income)
                .Sum(n => n.Total);
            var expense = nets
                .Where(n => n.AccountId == account.Id && n.Type == TransactionType.Expense)
                .Sum(n => n.Total);
            var transferOut = transfers
                .Where(t => t.AccountId == account.Id)
                .Sum(t => t.Amount);
            var transferIn = transfers
                .Where(t => t.TransferAccountId == account.Id)
                .Sum(t => t.Amount);

            account.CurrentBalance = account.OpeningBalance + income - expense - transferOut + transferIn;
        }
    }
}
