using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Accounts.Dtos;

public class AccountDto
{
    public Guid Id { get; set; }
    public string Name { get; set; } = string.Empty;

    /// <summary>The account kind (Current/Savings/Cash/CreditCard/Other) as its numeric enum value.</summary>
    public AccountType Type { get; set; }

    /// <summary>ISO 4217 code the account is held in (e.g. "EUR").</summary>
    public string Currency { get; set; } = "EUR";

    public decimal OpeningBalance { get; set; }

    /// <summary>Opening balance plus the net of the account's assigned transactions.</summary>
    public decimal CurrentBalance { get; set; }

    public int DisplayOrder { get; set; }
}

public static class AccountMapping
{
    public static AccountDto ToDto(this Account a) => new()
    {
        Id = a.Id,
        Name = a.Name,
        Type = a.Type,
        Currency = a.Currency.Value,
        OpeningBalance = a.OpeningBalance,
        CurrentBalance = a.CurrentBalance,
        DisplayOrder = a.DisplayOrder,
    };
}
