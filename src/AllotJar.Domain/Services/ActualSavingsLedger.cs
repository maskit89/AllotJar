using System.Collections.ObjectModel;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Domain.Services;

/// <summary>
/// A signed allocation to a jar, or to unallocated account funds (null JarId).
/// These are actual-money postings, never budget-line plans.
/// </summary>
public sealed record JarLedgerPosting(Guid? JarId, decimal Amount);

/// <summary>
/// One account leg of a recorded transaction, or a zero-sum allocation of money
/// already in that account. Both sides of a transfer share a transaction identity
/// but have distinct account operations. Initial jar funding is a zero-sum operation.
/// Persistence, import matching, permissions and write concurrency belong to callers.
/// </summary>
public sealed record JarLedgerOperation(
    Guid Id, string OwnerId, Guid AccountId, DateOnly Date, Guid? TransactionId,
    IReadOnlyList<JarLedgerPosting> Postings);

/// <summary>
/// Calculates a fully attributed savings ledger. Missing transaction allocations
/// are rejected rather than silently selecting an outgoing jar or unallocated funds.
/// This foundation is not yet connected to the existing plan-based jar endpoints.
/// Callers must supply account/jar definitions valid for the requested period;
/// changing a jar's designated account requires a separate history-aware workflow.
/// </summary>
public static class ActualSavingsLedger
{
    public static SavingsLedgerBalance Calculate(
        Account account, DateOnly openingDate, DateOnly asOf,
        IReadOnlyCollection<Jar> jars,
        IReadOnlyCollection<Transaction> transactions,
        IReadOnlyCollection<JarLedgerOperation> operations,
        IReadOnlyDictionary<Guid, TransferPostingDates>? transferDates = null)
    {
        if (account.Type != AccountType.Savings)
            throw new InvalidOperationException("Jar money must reside in a designated savings account.");
        if (asOf < openingDate) return new(asOf, null, null, null);

        var movements = ActualAccountLedger.Movements(account, openingDate, asOf, transactions, transferDates);
        // Archived jars still own money and must remain in reconciliation. Ignore
        // legacy Jar.OpeningBalance: existing account money needs an explicit allocation.
        var jarBalances = jars.Where(j => j.OwnerId == account.OwnerId && j.FundingAccountId == account.Id)
            .ToDictionary(j => j.Id, _ => 0m);
        var operationIds = new HashSet<Guid>();
        var allocatedTransactions = new HashSet<Guid>();
        var unallocated = account.OpeningBalance;

        foreach (var operation in operations.Where(o => o.OwnerId == account.OwnerId &&
                     o.AccountId == account.Id && o.Date >= openingDate && o.Date <= asOf))
        {
            if (!operationIds.Add(operation.Id))
                throw new InvalidOperationException("The same allocation operation cannot be counted twice.");
            if (operation.Postings.Count == 0)
                throw new InvalidOperationException("An allocation operation requires explicit postings.");

            decimal expected = 0;
            if (operation.TransactionId is Guid transactionId)
            {
                if (!movements.TryGetValue(transactionId, out var movement) || movement.Date != operation.Date)
                    throw new InvalidOperationException("An allocation must match its transaction account and date.");
                expected = movement.Amount;
                if (!allocatedTransactions.Add(transactionId))
                    throw new InvalidOperationException("A transaction account leg can only be allocated once.");
                if (operation.Postings.Any(p => Math.Sign(p.Amount) != Math.Sign(expected)))
                    throw new InvalidOperationException("Transaction allocations must follow the money movement's direction.");
            }
            if (operation.Postings.Sum(p => p.Amount) != expected)
                throw new InvalidOperationException("Allocations must conserve the exact account movement; reallocations must sum to zero.");

            foreach (var posting in operation.Postings)
            {
                if (posting.JarId is Guid jarId)
                {
                    if (!jarBalances.ContainsKey(jarId))
                        throw new InvalidOperationException("An allocation jar must belong to this owner and designate this savings account.");
                    jarBalances[jarId] += posting.Amount;
                }
                else unallocated += posting.Amount;
            }
        }
        if (allocatedTransactions.Count != movements.Count)
            throw new InvalidOperationException("Every savings-account movement requires an explicit jar/unallocated allocation.");

        var balance = account.OpeningBalance + movements.Values.Sum(m => m.Amount);
        if (jarBalances.Values.Sum() + unallocated != balance)
            throw new InvalidOperationException("Jar and unallocated balances must reconcile to account money.");
        return new(asOf, balance, new ReadOnlyDictionary<Guid, decimal>(jarBalances), unallocated);
    }
}

/// <summary>
/// Read-only arithmetic result, not authorisation to persist a withdrawal. Write paths
/// must reject a savings-account deficit and apply their concurrency safeguards.
/// Negative jar balances are retained; they are not account overdrafts.
/// </summary>
public sealed record SavingsLedgerBalance(
    DateOnly AsOf, decimal? AccountBalance,
    IReadOnlyDictionary<Guid, decimal>? JarBalances, decimal? Unallocated)
{
    public bool IsAvailable => AccountBalance.HasValue;
    public bool HasAccountDeficit => AccountBalance < 0;
    public bool HasUnallocatedDeficit => Unallocated < 0;
}
