using AllotJar.Application.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Dtos;

public class AccountDto
{
    public Guid Id { get; set; }

    /// <summary>The row version the edit form sends back with its save (D11); null where the store keeps none.</summary>
    public string? Version { get; set; }

    public string Name { get; set; } = string.Empty;

    /// <summary>The account kind (Current/Savings/Cash/Other; credit cards are not accounts, rule 75) as its numeric enum value.</summary>
    public AccountType Type { get; set; }

    /// <summary>ISO 4217 code the account is held in (e.g. "EUR").</summary>
    public string Currency { get; set; } = "EUR";

    public decimal OpeningBalance { get; set; }

    /// <summary>The date the opening balance applies from (start of day). Null only on rows recorded before the date was required.</summary>
    public DateOnly? OpeningDate { get; set; }

    /// <summary>
    /// The account's actual money as of <see cref="BalanceAsOf"/>: opening balance plus every
    /// posted leg dated from the opening date to that day. Null when unavailable — no opening
    /// date on record, or the as-of date is before it — never zero (rule 67).
    /// </summary>
    public decimal? CurrentBalance { get; set; }

    /// <summary>The date <see cref="CurrentBalance"/> is calculated as of.</summary>
    public DateOnly BalanceAsOf { get; set; }

    /// <summary>True when <see cref="CurrentBalance"/> is null because no opening date is recorded.</summary>
    public bool OpeningDateMissing { get; set; }

    /// <summary>Confirmed departures from this account whose receipt is not yet confirmed (already excluded from the balance).</summary>
    public decimal InTransitOut { get; set; }

    /// <summary>Confirmed departures towards this account not yet received (not part of the balance).</summary>
    public decimal InTransitIn { get; set; }

    /// <summary>Receipts identified as own-account transfers awaiting their departure details (rule 72); none is posted.</summary>
    public int PendingReceiptCount { get; set; }

    /// <summary>Total of the pending receipts, in the account currency, for the review highlight.</summary>
    public decimal PendingReceiptTotal { get; set; }

    /// <summary>True when the posted balance is flagged for review: it does not yet reflect a pending receipt.</summary>
    public bool RequiresReview { get; set; }

    public int DisplayOrder { get; set; }

    /// <summary>Optional bank identifiers (rule 76); null when not recorded.</summary>
    public string? Iban { get; set; }
    public string? Bic { get; set; }
    public string? SortCode { get; set; }
    public string? AccountNumber { get; set; }

    /// <summary>
    /// Who holds the account (rule 30): one person is a personal account, several a joint one,
    /// none the household's own.
    /// </summary>
    public IReadOnlyList<AccountHolderDto> Holders { get; set; } = Array.Empty<AccountHolderDto>();

    /// <summary>True when only the caller's login sees this account (rules 31–33).</summary>
    public bool IsPrivate { get; set; }

    /// <summary>True when the caller's own person is the only holder, so the caller chooses who sees it (P54).</summary>
    public bool CanChangeSharing { get; set; }

    /// <summary>
    /// When the caller could choose but the account can't be private (a jar uses it, P55): why.
    /// Null otherwise.
    /// </summary>
    public string? SharingBlockedReason { get; set; }
}

/// <summary>A person who holds an account.</summary>
public class AccountHolderDto
{
    public Guid MemberId { get; set; }
    public string Name { get; set; } = string.Empty;
}

public static class AccountMapping
{
    public static AccountDto ToDto(this Account a, AccountLedgerView ledger) => new()
    {
        Id = a.Id,
        Version = EditVersions.Of(a),
        Name = a.Name,
        Type = a.Type,
        Currency = a.Currency.Value,
        OpeningBalance = a.OpeningBalance,
        OpeningDate = a.OpeningDate,
        CurrentBalance = ledger.Balance,
        BalanceAsOf = ledger.AsOf,
        OpeningDateMissing = ledger.OpeningDateMissing,
        InTransitOut = ledger.InTransitOut,
        InTransitIn = ledger.InTransitIn,
        PendingReceiptCount = ledger.PendingReceipts.Count,
        PendingReceiptTotal = ledger.PendingReceiptTotal,
        RequiresReview = ledger.RequiresReview,
        DisplayOrder = a.DisplayOrder,
        Iban = a.Iban,
        Bic = a.Bic,
        SortCode = a.SortCode,
        AccountNumber = a.AccountNumber,
    };
}
