using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A real-world place the user's money sits (a current account, savings pot, cash;
/// credit cards are not accounts, rule 75). Its balance is not stored: it is derived at read time as the
/// <see cref="OpeningBalance"/> plus every assigned transaction (income adds, expense
/// subtracts), so the transaction register stays the single source of truth. This is
/// a "where my money is" view alongside the budget, not part of the zero-based plan.
/// </summary>
public class Account : BaseEntity, IVersioned
{
    /// <inheritdoc />
    public byte[] Version { get; set; } = [];

    /// <summary>Identity user id that owns this account.</summary>
    public string OwnerId { get; set; } = string.Empty;

    [MaskCardNumbers]
    public string Name { get; set; } = string.Empty;

    public AccountType Type { get; set; } = AccountType.Current;

    /// <summary>The currency the account is held in. Balances are shown in this currency.</summary>
    public CurrencyCode Currency { get; set; } = CurrencyCode.Eur;

    /// <summary>
    /// The balance the account held at the start of <see cref="OpeningDate"/>, before any
    /// tracked transaction dated on or after it. Never negative (rule 74). Mapped to decimal(18,4).
    /// </summary>
    public decimal OpeningBalance { get; set; }

    /// <summary>
    /// The date the <see cref="OpeningBalance"/> applies from (rule 40): transactions dated
    /// earlier remain history but never change the balance again, and a balance as of an
    /// earlier date is unavailable rather than reconstructed (rule 67). Required for every
    /// account written by the API; null only on rows that predate the column, whose balance
    /// is therefore unavailable until the user records the date — never inferred.
    /// </summary>
    public DateOnly? OpeningDate { get; set; }

    public int DisplayOrder { get; set; }

    /// <summary>
    /// Optional bank identifiers (rule 76). Never required — an account may be a physical place
    /// such as a piggy bank — and only format-checked when supplied.
    /// </summary>
    public string? Iban { get; set; }
    public string? Bic { get; set; }
    public string? SortCode { get; set; }
    public string? AccountNumber { get; set; }

    /// <summary>
    /// The people who hold the account (rule 30): one is a personal account, several a joint one,
    /// none the household's own. One balance and one history whoever holds it.
    /// </summary>
    public ICollection<AccountHolder> Holders { get; set; } = new List<AccountHolder>();

    /// <summary>
    /// Present when the account is private to one login (rules 31–33); null when the household
    /// shares it. Loaded only for the login allowed to see a private account.
    /// </summary>
    public AccountPrivacy? Privacy { get; set; }

    /// <summary>The transactions that have moved money in or out of this account.</summary>
    public ICollection<Transaction> Transactions { get; set; } = new List<Transaction>();
}
