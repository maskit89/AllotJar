namespace AllotJar.Application.Jars.Dtos;

/// <summary>
/// One jar-backed account's ledger (rules 2–6, 70): its actual balance, each jar's allocated
/// balance and the unallocated remainder, which always reconcile. Null money means unavailable.
/// </summary>
public class JarAccountLedgerDto
{
    public Guid AccountId { get; set; }
    public string AccountName { get; set; } = string.Empty;
    public string Currency { get; set; } = "EUR";
    public DateOnly AsOf { get; set; }
    public decimal? AccountBalance { get; set; }
    public decimal? Unallocated { get; set; }

    /// <summary>The sum of positive jar balances; must not exceed <see cref="AccountBalance"/> (rule 70).</summary>
    public decimal PositiveAllocations { get; set; }

    /// <summary>True when positive jars exceed the account's money: an explicit reallocation is required before further moves.</summary>
    public bool HasBackingDeficit { get; set; }

    /// <summary>Stored transaction allocations that no longer match their transaction and were set aside for review.</summary>
    public int UnreconciledAllocations { get; set; }

    public bool RequiresReview { get; set; }
    public IReadOnlyList<JarLedgerLineDto> Jars { get; set; } = Array.Empty<JarLedgerLineDto>();
}

public class JarLedgerLineDto
{
    public Guid JarId { get; set; }
    public string Name { get; set; } = string.Empty;
    public decimal Balance { get; set; }
    public bool IsArchived { get; set; }
}

public static class JarAccountLedgerMapping
{
    public static JarAccountLedgerDto ToDto(this JarLedgerView view, JarLedgerSnapshot snapshot) => new()
    {
        AccountId = view.Account.Id,
        AccountName = view.Account.Name,
        Currency = view.Account.Currency.Value,
        AsOf = view.AsOf,
        AccountBalance = view.AccountBalance,
        Unallocated = view.Unallocated,
        PositiveAllocations = view.PositiveAllocations,
        HasBackingDeficit = view.HasBackingDeficit,
        UnreconciledAllocations = view.UnreconciledAllocations,
        RequiresReview = view.RequiresReview,
        Jars = snapshot.Jars.Values
            .Where(j => j.FundingAccountId == view.Account.Id)
            .OrderBy(j => j.Name, StringComparer.OrdinalIgnoreCase)
            .Select(j => new JarLedgerLineDto
            {
                JarId = j.Id,
                Name = j.Name,
                Balance = view.JarBalances.TryGetValue(j.Id, out var b) ? b : 0m,
                IsArchived = j.IsArchived,
            })
            .ToList(),
    };
}
