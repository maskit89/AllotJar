namespace AllotJar.Domain.Entities;

/// <summary>
/// Marks an <see cref="Account"/> private (rules 31–33, P53/P54): only the login in
/// <see cref="UserId"/> sees it — its balance, its history and its name. Everyone else in the
/// household reads as if it did not exist, except where its holder put money on a household budget
/// line (P56) or it is one side of a transfer with a shared account (P57); there it is named
/// "Private account". No row means the account is shared with the whole household.
/// <para>
/// Privacy belongs to the login that chose it, not to the budget person: re-linking or revoking a
/// login never hands the account to someone else (P59). Kept in its own table so the read filters
/// on accounts and transactions can consult it without being filtered themselves.
/// </para>
/// </summary>
public class AccountPrivacy
{
    public Guid AccountId { get; set; }

    /// <summary>The identity user id of the only login that may see the account.</summary>
    public string UserId { get; set; } = string.Empty;

    public DateTime SinceUtc { get; set; } = DateTime.UtcNow;
}
