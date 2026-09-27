using AllotJar.Domain.Entities;

namespace AllotJar.Domain.Services;

/// <summary>The first date on which an account's recorded balance would fall below zero, and that balance.</summary>
public sealed record AccountShortfall(DateOnly Date, decimal Balance);

/// <summary>
/// Rule 74: no account may have a negative recorded balance on any date, whatever its type and
/// whatever overdraft the bank allows. A pure check over the supplied transactions (the caller
/// composes the candidate state, including any unsaved change); it neither posts nor rejects
/// anything itself. Rows before the opening date are history only (rule 40) and never count.
/// </summary>
public static class AccountBalanceRules
{
    /// <summary>
    /// Walks the account's movements day by day from its opening balance and returns the first
    /// end-of-day balance below zero, or null when the account never dips. A transfer receipt
    /// still pending review is evidence, not money, and does not count (rule 72).
    /// </summary>
    public static AccountShortfall? FirstShortfall(
        Account account, DateOnly openingDate,
        IReadOnlyCollection<Transaction> transactions,
        IReadOnlyDictionary<Guid, TransferPostingDates>? transferDates = null)
    {
        var entries = ActualAccountLedger.Entries(account, openingDate, DateOnly.MaxValue, transactions, transferDates);
        var running = account.OpeningBalance;
        if (running < 0m)
            return new AccountShortfall(openingDate, running);
        foreach (var day in entries.Movements.Values.GroupBy(m => m.Date).OrderBy(g => g.Key))
        {
            running += day.Sum(m => m.Amount);
            if (running < 0m)
                return new AccountShortfall(day.Key, running);
        }
        return null;
    }
}
