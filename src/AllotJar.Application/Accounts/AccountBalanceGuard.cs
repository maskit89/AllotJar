using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.Services;

namespace AllotJar.Application.Accounts;

/// <summary>
/// Rule 74 at every write that moves money: the candidate state of each affected account — its
/// stored transactions with the caller's unsaved additions, edits and deletions applied — must
/// never dip below zero on any date. A breach is refused with the account, the balance and the
/// date, so the user records the missing deposit or corrects the amount; nothing is posted
/// "anyway" and no balancing entry is invented. Callers hold the account's ledger write lock
/// where two writers could otherwise both pass against the same money.
/// </summary>
public static class AccountBalanceGuard
{
    /// <param name="accounts">The accounts to check (loaded by the caller, tracked or not).</param>
    /// <param name="pending">Unsaved transactions in their intended final state; they replace any stored row with the same id.</param>
    /// <param name="removedIds">Stored transactions the write deletes.</param>
    public static async Task EnsureNonNegativeAsync(
        IApplicationDbContext db,
        IReadOnlyCollection<Account> accounts,
        IReadOnlyCollection<Transaction> pending,
        IReadOnlyCollection<Guid> removedIds,
        string errorKey,
        CancellationToken cancellationToken)
    {
        var shortfall = await FirstShortfallAsync(db, accounts, pending, removedIds, cancellationToken);
        if (shortfall is not null)
        {
            throw new ValidationException(new Dictionary<string, string[]> { [errorKey] = new[] { shortfall } });
        }
    }

    /// <summary>The refusal message for the first account that would dip below zero, or null when none would.</summary>
    public static async Task<string?> FirstShortfallAsync(
        IApplicationDbContext db,
        IReadOnlyCollection<Account> accounts,
        IReadOnlyCollection<Transaction> pending,
        IReadOnlyCollection<Guid> removedIds,
        CancellationToken cancellationToken)
    {
        var checkable = accounts.Where(a => a.OpeningDate is not null).DistinctBy(a => a.Id).ToList();
        if (checkable.Count == 0)
        {
            return null;
        }
        var ids = checkable.Select(a => a.Id).ToList();
        var ownerIds = checkable.Select(a => a.OwnerId).Distinct().ToList();
        var excluded = removedIds.Concat(pending.Select(t => t.Id)).ToHashSet();

        var stored = await db.Transactions
            .AsNoTracking()
            .Where(t => ownerIds.Contains(t.OwnerId)
                        && ((t.AccountId != null && ids.Contains(t.AccountId.Value))
                            || (t.Type == TransactionType.Transfer
                                && t.TransferAccountId != null
                                && ids.Contains(t.TransferAccountId.Value))))
            .ToListAsync(cancellationToken);

        var candidate = stored.Where(t => !excluded.Contains(t.Id)).Concat(pending).ToList();
        return FirstShortfall(checkable, candidate);
    }

    /// <summary>Pure variant over an already composed candidate state (import rows are evaluated one by one against it).</summary>
    public static string? FirstShortfall(IReadOnlyCollection<Account> accounts, IReadOnlyCollection<Transaction> candidate)
    {
        var readable = candidate
            .Where(t => t.Type != TransactionType.Transfer || (t.AccountId is not null && t.TransferAccountId is not null))
            .ToList();
        var postingDates = TransferLedger.PostingDates(readable);
        foreach (var account in accounts)
        {
            if (account.OpeningDate is not DateOnly opening)
            {
                continue;
            }
            var shortfall = AccountBalanceRules.FirstShortfall(account, opening, readable, postingDates);
            if (shortfall is not null)
            {
                return Message(account, shortfall);
            }
        }
        return null;
    }

    public static string Message(Account account, AccountShortfall shortfall) =>
        $"{account.Name} would be {shortfall.Balance:0.00} {account.Currency.Value} on {shortfall.Date:yyyy-MM-dd}. " +
        "An account never goes below zero here: record the money that reached it first, or correct this amount.";
}
