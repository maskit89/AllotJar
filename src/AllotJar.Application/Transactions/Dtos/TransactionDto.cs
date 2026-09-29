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

    /// <summary>
    /// True when an account this money moved in is private to another login (P56/P57): its name
    /// reads "Private account" and only its holder can change the entry.
    /// </summary>
    public bool InPrivateAccount { get; set; }

    /// <summary>For a transfer: the source bank's posting date, or null while the departure is unknown (held for review).</summary>
    public DateOnly? DepartedOn { get; set; }

    /// <summary>For a transfer: the destination bank's posting date, or null while the money is in transit.</summary>
    public DateOnly? ReceivedOn { get; set; }

    /// <summary>For a transfer: the destination statement's reference for the credit leg (the source reference is <see cref="BankReference"/>).</summary>
    public string? ReceiptBankReference { get; set; }

    /// <summary>For a transfer: Completed | InTransit | PendingReview, derived from the two bank legs. Null for income/expense rows.</summary>
    public string? TransferStatus { get; set; }

    /// <summary>
    /// For a refund (rules 38/39): the purchase this money came back from, with enough of it to
    /// label the row ("Refund of Payee · date"). A refund is money received but never income; it
    /// reduces net spending on the expense/savings line it is assigned to. Null otherwise.
    /// </summary>
    public Guid? RefundOfTransactionId { get; set; }
    public string? RefundOfPayee { get; set; }
    public DateOnly? RefundOfDate { get; set; }

    /// <summary>The purchase's amount in the budget base currency, so the client can offer only what remains.</summary>
    public decimal? RefundOfAmount { get; set; }

    /// <summary>For a purchase: how many refunds point at it, and their base-currency total (0 when none).</summary>
    public int RefundCount { get; set; }
    public decimal RefundedAmount { get; set; }

    /// <summary>The household member this whole transaction is attributed to, if any.</summary>
    public Guid? MemberId { get; set; }
    public string? MemberName { get; set; }

    /// <summary>True when the transaction is split across budget lines.</summary>
    public bool IsSplit { get; set; }

    /// <summary>The per-line slices when <see cref="IsSplit"/>; empty otherwise.</summary>
    public IReadOnlyList<TransactionSplitDto> Splits { get; set; } = Array.Empty<TransactionSplitDto>();

    /// <summary>
    /// The stored jar split of each account leg (rules 78/79): signed amounts per jar, a null jar
    /// meaning unallocated. Empty when the leg follows the derived default (incoming money
    /// unallocated; a payment drawn from its budget line's jar or unallocated).
    /// </summary>
    public IReadOnlyList<TransactionJarAllocationDto> JarAllocations { get; set; } = Array.Empty<TransactionJarAllocationDto>();
}

public class TransactionJarAllocationDto
{
    public Guid AccountId { get; set; }
    public Guid? JarId { get; set; }
    public string? JarName { get; set; }
    public decimal Amount { get; set; }
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
    /// <summary>How an account private to another login is named wherever its money is visible (P56/P57).</summary>
    public const string PrivateAccountName = "Private account";

    // Every read path loads (or tracks) the account navigations, and the query filter leaves one
    // empty only when the account is private to another login.
    private static bool Hidden(Guid? id, Account? account) => id is not null && account is null;

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
        // A private account's id stays out too, so the others can't tell its entries apart (P56).
        AccountId = Hidden(t.AccountId, t.Account) ? null : t.AccountId,
        AccountName = Hidden(t.AccountId, t.Account) ? PrivateAccountName : t.Account?.Name,
        TransferAccountId = Hidden(t.TransferAccountId, t.TransferAccount) ? null : t.TransferAccountId,
        TransferAccountName = Hidden(t.TransferAccountId, t.TransferAccount) ? PrivateAccountName : t.TransferAccount?.Name,
        InPrivateAccount = Hidden(t.AccountId, t.Account) || Hidden(t.TransferAccountId, t.TransferAccount),
        DepartedOn = t.Type == TransactionType.Transfer ? t.DepartedOn : null,
        ReceivedOn = t.Type == TransactionType.Transfer ? t.ReceivedOn : null,
        ReceiptBankReference = t.Type == TransactionType.Transfer ? t.ReceiptBankReference : null,
        TransferStatus = t.Type == TransactionType.Transfer ? t.TransferStatus.ToString() : null,
        RefundOfTransactionId = t.RefundOfTransactionId,
        RefundOfPayee = t.RefundOf?.Payee,
        RefundOfDate = t.RefundOf?.Date,
        RefundOfAmount = t.RefundOf?.BaseAmount,
        RefundCount = t.Refunds.Count,
        RefundedAmount = t.Refunds.Sum(r => r.BaseAmount),
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
        JarAllocations = t.JarAllocations
            .SelectMany(a => a.Postings.Select(p => new TransactionJarAllocationDto
            {
                AccountId = a.AccountId,
                JarId = p.JarId,
                JarName = p.Jar?.Name,
                Amount = p.Amount,
            }))
            .ToList(),
    };
}
