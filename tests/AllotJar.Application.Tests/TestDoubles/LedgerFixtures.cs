using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.TestDoubles;

/// <summary>
/// Seeds the actual-money model the jar ledger reads (rules 1–6, 73, 77, 79): every jar has a
/// designated account with an opening date and a non-negative opening balance; money reaches a
/// jar only through a stored allocation or a jar-line expense from that account. Nothing here
/// writes a plan.
/// </summary>
public static class LedgerFixtures
{
    public static readonly DateOnly DefaultOpening = new(2026, 1, 1);

    public static Account SeedAccount(
        ApplicationDbContext db, string ownerId, string name = "Savings", decimal opening = 1000m,
        DateOnly? openingDate = null, AccountType type = AccountType.Savings, string currency = "EUR",
        int order = 0)
    {
        var account = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = type,
            Currency = CurrencyCode.From(currency),
            OpeningBalance = opening,
            OpeningDate = openingDate ?? DefaultOpening,
            DisplayOrder = order,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    /// <summary>Divides money already in the account into the jar (rule 77): jar +amount, unallocated −amount.</summary>
    public static JarAllocation Allocate(
        ApplicationDbContext db, string ownerId, Guid accountId, Guid jarId, decimal amount, DateOnly? date = null,
        JarAllocationKind kind = JarAllocationKind.InitialAllocation)
    {
        var allocation = new JarAllocation
        {
            OwnerId = ownerId,
            AccountId = accountId,
            Kind = kind,
            Date = date ?? DefaultOpening,
            CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting>
            {
                new() { JarId = jarId, Amount = amount },
                new() { JarId = null, Amount = -amount },
            },
        };
        db.JarAllocations.Add(allocation);
        db.SaveChanges();
        return allocation;
    }

    /// <summary>An expense from <paramref name="accountId"/>, optionally on a budget line (a jar line draws from the jar, rule 79).</summary>
    public static Transaction Expense(
        ApplicationDbContext db, string ownerId, Guid accountId, decimal amount, DateOnly date, Guid? lineId = null,
        string currency = "EUR")
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            AccountId = accountId,
            BudgetItemId = lineId,
            Amount = amount,
            Currency = CurrencyCode.From(currency),
            Type = TransactionType.Expense,
            Date = date,
            Payee = "Shop",
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }

    public static Transaction Income(
        ApplicationDbContext db, string ownerId, Guid accountId, decimal amount, DateOnly date, Guid? lineId = null,
        string currency = "EUR")
    {
        var tx = new Transaction
        {
            OwnerId = ownerId,
            AccountId = accountId,
            BudgetItemId = lineId,
            Amount = amount,
            Currency = CurrencyCode.From(currency),
            Type = TransactionType.Income,
            Date = date,
            Payee = "Employer",
        };
        db.Transactions.Add(tx);
        db.SaveChanges();
        return tx;
    }
}
