namespace AllotJar.Application.Accounts.Dtos;

/// <summary>
/// An account private to a login that is no longer in the household (P59): nobody can see it,
/// change it or share it. The owner sees only its name, its holder and how many entries it
/// holds, never the entries, and may erase it for good with <c>EraseUnreachableAccount</c>.
/// </summary>
public class UnreachableAccountDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Currency { get; set; } = string.Empty;
    /// <summary>The person who holds the account, if still in the household.</summary>
    public string? HolderName { get; set; }
    /// <summary>When the account was made private.</summary>
    public DateTime PrivateSinceUtc { get; set; }
    /// <summary>Entries the erase would remove: the account's own rows and every transfer touching it, with their fees.</summary>
    public int EntryCount { get; set; }
}
