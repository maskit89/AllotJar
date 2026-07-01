using AllotJar.Domain.Common;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Domain.Entities;

/// <summary>
/// A real-world place the user's money sits (a current account, savings pot, cash,
/// a credit card). Its balance is not stored: it is derived at read time as the
/// <see cref="OpeningBalance"/> plus every assigned transaction (income adds, expense
/// subtracts), so the transaction register stays the single source of truth. This is
/// a "where my money is" view alongside the budget, not part of the zero-based plan.
/// </summary>
public class Account : BaseEntity
{
    /// <summary>Identity user id that owns this account.</summary>
    public string OwnerId { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public AccountType Type { get; set; } = AccountType.Current;

    /// <summary>The currency the account is held in. Balances are shown in this currency.</summary>
    public CurrencyCode Currency { get; set; } = CurrencyCode.Eur;

    /// <summary>
    /// The balance the account started with (before any tracked transactions). Can be
    /// negative — e.g. a credit card's opening debt. Mapped to decimal(18,4).
    /// </summary>
    public decimal OpeningBalance { get; set; }

    public int DisplayOrder { get; set; }

    /// <summary>The transactions that have moved money in or out of this account.</summary>
    public ICollection<Transaction> Transactions { get; set; } = new List<Transaction>();

    /// <summary>
    /// Transient (not persisted): the account's current balance — the
    /// <see cref="OpeningBalance"/> plus the net of its assigned transactions. Derived
    /// at read time (see AllotJar.Application.Accounts).
    /// </summary>
    public decimal CurrentBalance { get; set; }
}
