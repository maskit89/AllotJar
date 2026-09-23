namespace AllotJar.Domain.Services;

/// <summary>
/// Source-funds checks for reallocating existing savings. They do not apply to actual
/// spending: a recorded payment may make a jar negative. Callers must bind this snapshot
/// to the authorised source account/date, validate the destination/currency, confirm any
/// bank transfer and recheck under a database lock before persisting the whole operation.
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

    public static void Validate(
        SavingsLedgerBalance source, Guid? sourceJarId, decimal amount, bool requiresBankTransfer)
    {
        if (amount <= 0)
            throw new ArgumentOutOfRangeException(nameof(amount), "Reallocation amount must be positive.");
        var available = AvailableAmount(source, sourceJarId, requiresBankTransfer);
        if (amount > available)
            throw new InvalidOperationException("The reallocation exceeds the selected source's available money. Choose another source for the remainder.");
    }
}
