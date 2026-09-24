namespace AllotJar.Domain.Services;

/// <summary>
/// Source-funds and resulting-account checks for reallocating existing savings.
/// A recorded payment may make a jar negative, but negative jars must not hide positive
/// allocations exceeding the account's money. Callers must validate the source, then
/// ValidateResult for every affected account after explicit user-selected allocations.
/// Bind snapshots to authorised accounts/dates, validate destination/currency, confirm
/// bank transfers and recheck under a database lock before persisting the whole operation.
/// </summary>
public static class JarReallocationRules
{
    /// <param name="sourceJarId">Null selects the account's unallocated money.</param>
    /// <param name="requiresBankTransfer">
    /// True when the destination uses a different account. Moving jar ownership within
    /// one account does not debit the bank account and must not apply a second money cap.
    /// </param>
    public static decimal AvailableAmount(
        SavingsLedgerBalance source, Guid? sourceJarId, bool requiresBankTransfer)
    {
        if (!source.IsAvailable || source.JarBalances is null || source.Unallocated is null)
            throw new InvalidOperationException("The source balance is unavailable for this date.");
        if (source.HasAccountDeficit)
            throw new InvalidOperationException("Reconcile the savings-account deficit before reallocating money.");

        decimal allocated;
        if (sourceJarId is Guid jarId)
        {
            if (!source.JarBalances.TryGetValue(jarId, out allocated))
                throw new InvalidOperationException("The source jar is not part of this account's ledger.");
        }
        else allocated = source.Unallocated.Value;

        // Availability for this action is zero for a negative jar; the actual ledger
        // keeps its signed balance visible. Other jars' funds are never silently used.
        var available = Math.Max(0m, allocated);
        return requiresBankTransfer ? Math.Min(available, source.AccountBalance!.Value) : available;
    }

    /// <summary>
    /// Checks only the selected source. A source check alone cannot authorise a move:
    /// ValidateResult must also check every resulting account, including the destination.
    /// A currently under-backed account may need this move to explicitly cover its deficit.
    /// </summary>
    public static void Validate(
        SavingsLedgerBalance source, Guid? sourceJarId, decimal amount, bool requiresBankTransfer)
    {
        if (amount <= 0)
            throw new ArgumentOutOfRangeException(nameof(amount), "Reallocation amount must be positive.");
        var available = AvailableAmount(source, sourceJarId, requiresBankTransfer);
        if (amount > available)
            throw new InvalidOperationException("The reallocation exceeds the selected source's available money. Choose another source for the remainder.");
    }

    /// <summary>
    /// Checks the candidate ledger after the user's complete reallocation. Read calculations
    /// remain able to expose deficits; this guard neither hides an actual payment nor chooses
    /// which other jar must give up money. Pending transfers do not back destination jars.
    /// </summary>
    public static void ValidateResult(SavingsLedgerBalance result)
    {
        if (!result.IsAvailable || result.JarBalances is null || result.Unallocated is null)
            throw new InvalidOperationException("The resulting balance is unavailable for this date.");
        if (result.HasAccountDeficit)
            throw new InvalidOperationException("A savings account cannot have a negative balance.");
        if (result.JarBalances.Values.Sum() + result.Unallocated.Value != result.AccountBalance)
            throw new InvalidOperationException("The resulting allocations must reconcile to the account's actual money.");

        // Signed totals alone are insufficient: Holiday -50 and Repairs 400 reconcile
        // to a 350 bank balance, but Repairs' positive 400 is not fully backed.
        var positiveAllocations = result.JarBalances.Values.Where(amount => amount > 0m).Sum();
        if (positiveAllocations > result.AccountBalance!.Value)
            throw new InvalidOperationException("Positive jar balances exceed the account's actual money. Explicitly reallocate funds to cover the deficit.");
    }
}
