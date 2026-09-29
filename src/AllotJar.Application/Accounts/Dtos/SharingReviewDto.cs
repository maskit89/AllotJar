namespace AllotJar.Application.Accounts.Dtos;

/// <summary>
/// The caller's personal accounts and whether they still owe a sharing review (rule 32, P58): the
/// login was linked to a person who already held accounts, or someone else added one for them.
/// </summary>
public class SharingReviewDto
{
    /// <summary>True when the caller should be asked to review who sees these accounts.</summary>
    public bool Pending { get; set; }

    /// <summary>Every account whose only holder is the caller's own person.</summary>
    public IReadOnlyList<AccountDto> Accounts { get; set; } = Array.Empty<AccountDto>();
}
