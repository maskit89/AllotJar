using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.Application.Tests.Infrastructure;

/// <summary>
/// Compliance fix 12: every save masks a card number in typed text, whichever handler wrote it,
/// and never touches a bank reference.
/// </summary>
public class CardNumberSaveTests
{
    private const string Card = "4111 1111 1111 1111";
    private const string Masked = "•••• •••• •••• 1111";

    [Fact]
    public async Task AddingATransaction_MasksPayeeAndNotes_ButNotItsBankReference()
    {
        await using var db = NewContext();
        var row = new Transaction
        {
            OwnerId = "user-1", Type = TransactionType.Expense, Amount = 10m, Currency = CurrencyCode.Eur,
            Date = new DateOnly(2026, 10, 1), Payee = $"Shop {Card}", Notes = $"paid with {Card}",
            BankReference = "4111111111111111",
        };
        db.Transactions.Add(row);

        await db.SaveChangesAsync();

        row.Payee.Should().Be($"Shop {Masked}", "the caller's entity reads as stored");
        var stored = await db.Transactions.AsNoTracking().SingleAsync();
        stored.Payee.Should().Be($"Shop {Masked}");
        stored.Notes.Should().Be($"paid with {Masked}");
        stored.BankReference.Should().Be("4111111111111111", "a bank reference identifies the entry for duplicate detection");
    }

    [Fact]
    public async Task EditingText_MasksTheNewValue()
    {
        await using var db = NewContext();
        var row = new Transaction
        {
            OwnerId = "user-1", Type = TransactionType.Expense, Amount = 10m, Currency = CurrencyCode.Eur,
            Date = new DateOnly(2026, 10, 1), Payee = "Shop",
        };
        db.Transactions.Add(row);
        await db.SaveChangesAsync();

        row.Notes = $"card {Card}";
        await db.SaveChangesAsync();

        (await db.Transactions.AsNoTracking().SingleAsync()).Notes.Should().Be($"card {Masked}");
    }

    [Fact]
    public async Task NamesAndNotes_OfOtherRecords_AreMaskedToo()
    {
        await using var db = NewContext();
        db.Accounts.Add(new Account { OwnerId = "user-1", Name = $"Visa {Card}", Type = AccountType.Current });
        db.HouseholdMembers.Add(new HouseholdMember { OwnerId = "user-1", Name = $"Alex {Card}" });

        await db.SaveChangesAsync();

        (await db.Accounts.AsNoTracking().SingleAsync()).Name.Should().Be($"Visa {Masked}");
        (await db.HouseholdMembers.AsNoTracking().SingleAsync()).Name.Should().Be($"Alex {Masked}");
    }
}
