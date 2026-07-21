using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;

namespace AllotJar.Application.Transactions.Dtos;

public class TransactionDto
{
    public Guid Id { get; set; }
    public DateOnly Date { get; set; }
    public string Payee { get; set; } = string.Empty;
    public decimal Amount { get; set; }
    public string Currency { get; set; } = "EUR";
    public decimal ExchangeRate { get; set; }

    /// <summary>Amount in the budget base currency (Amount × ExchangeRate).</summary>
    public decimal BaseAmount { get; set; }

    /// <summary>True when this foreign row's exchange rate is unresolved (ExchangeRate is a
    /// placeholder 1); it counts at face value until reconciled. Lets the UI flag it.</summary>
    public bool FxPending { get; set; }

    public TransactionType Type { get; set; }
    public string? BankReference { get; set; }

    public Guid? BudgetItemId { get; set; }
    public string? BudgetItemName { get; set; }

    /// <summary>
    /// The calendar year/month of the budget month the assigned line belongs to. A transaction can
    /// legitimately be budgeted to a line in a different month than its own date (e.g. a 31 Jan
    /// purchase budgeted to a February line); the register surfaces that. Null when unassigned or
    /// when the line's month navigation wasn't loaded.
    /// </summary>
    public int? BudgetItemYear { get; set; }
    public int? BudgetItemMonth { get; set; }

    /// <summary>The account this money moved in/out of, if any (the source for a transfer).</summary>
    public Guid? AccountId { get; set; }
    public string? AccountName { get; set; }

    /// <summary>For a transfer, the destination account the money moved into.</summary>
    public Guid? TransferAccountId { get; set; }
    public string? TransferAccountName { get; set; }

    /// <summary>The household member this whole transaction is attributed to, if any.</summary>
    public Guid? MemberId { get; set; }
    public string? MemberName { get; set; }

    /// <summary>True when the transaction is split across budget lines.</summary>
    public bool IsSplit { get; set; }

    /// <summary>The per-line slices when <see cref="IsSplit"/>; empty otherwise.</summary>
    public IReadOnlyList<TransactionSplitDto> Splits { get; set; } = Array.Empty<TransactionSplitDto>();
}

public class TransactionSplitDto
{
    public Guid Id { get; set; }
    public Guid? BudgetItemId { get; set; }
    public string? BudgetItemName { get; set; }
    public Guid? MemberId { get; set; }
    public string? MemberName { get; set; }
    public decimal Amount { get; set; }
}

public static class TransactionMapping
{
    public static TransactionDto ToDto(this Transaction t) => new()
    {
        Id = t.Id,
        Date = t.Date,
        Payee = t.Payee,
        Amount = t.Amount,
        Currency = t.Currency.Value,
        ExchangeRate = t.ExchangeRate,
        BaseAmount = t.BaseAmount,
        FxPending = t.FxPending,
        Type = t.Type,
        BankReference = t.BankReference,
        BudgetItemId = t.BudgetItemId,
        BudgetItemName = t.BudgetItem?.Name,
        // Null-safe through the whole chain: stays null if any nav (or the month) isn't loaded.
        BudgetItemYear = t.BudgetItem?.BudgetCategory?.BudgetMonth?.Year,
        BudgetItemMonth = t.BudgetItem?.BudgetCategory?.BudgetMonth?.Month,
        AccountId = t.AccountId,
        AccountName = t.Account?.Name,
        TransferAccountId = t.TransferAccountId,
        TransferAccountName = t.TransferAccount?.Name,
        MemberId = t.MemberId,
        MemberName = t.Member?.Name,
        IsSplit = t.Splits.Count > 0,
        Splits = t.Splits
            .Select(s => new TransactionSplitDto
            {
                Id = s.Id,
                BudgetItemId = s.BudgetItemId,
                BudgetItemName = s.BudgetItem?.Name,
                MemberId = s.MemberId,
                MemberName = s.Member?.Name,
                Amount = s.Amount,
            })
            .ToList(),
    };
}
