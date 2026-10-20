using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Compliance fix 12 on real SQL Server: the startup check finds a card number stored before every
/// save masked them (its 13-digit LIKE prefilter must translate and match, and its pages must
/// walk by id), reports the rows by id and changes nothing.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class CardNumberCheckSqlTests
{
    private const string Card = "4111111111111111";

    private readonly SqlServerFixture _fixture;

    public CardNumberCheckSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Check_ReportsRowsHoldingACardNumber_ByIdOnly_AndChangesNothing()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        Guid accountId, encryptedAccountId, cardRowId, referenceRowId;
        await using (var db = _fixture.CreateContext())
        {
            var account = new Account { OwnerId = owner, Name = "Current", Currency = CurrencyCode.Eur };
            // Saved through EF, so stored encrypted (compliance fix 10): only the decrypted value shows the card.
            var encryptedAccount = new Account { OwnerId = owner, Name = "Savings", Currency = CurrencyCode.Eur, AccountNumber = Card };
            db.Accounts.AddRange(account, encryptedAccount);
            encryptedAccountId = encryptedAccount.Id;
            Transaction Row(string payee) => new()
            {
                OwnerId = owner, Account = account, Type = TransactionType.Expense, Amount = 1m,
                Currency = CurrencyCode.Eur, Date = new DateOnly(2026, 6, 1), Payee = payee,
            };
            var cardRow = Row("placeholder");
            var referenceRow = Row("Loan 1234567890128"); // 13 digits, Luhn-valid, no card scheme
            db.Transactions.AddRange(cardRow, referenceRow);
            await db.SaveChangesAsync();
            (accountId, cardRowId, referenceRowId) = (account.Id, cardRow.Id, referenceRow.Id);

            // What a save before fix 12 stored. Every save masks now, so write it with SQL.
            await db.Database.ExecuteSqlAsync(
                $"UPDATE Transactions SET Payee = {"AMAZON " + Card} WHERE Id = {cardRowId}");
            await db.Database.ExecuteSqlAsync(
                $"UPDATE Accounts SET AccountNumber = {Card} WHERE Id = {accountId}");
        }

        await using (var db = _fixture.CreateContext())
        {
            var found = await CardNumberCheck.FindAsync(db);

            found["Transactions"].Should().Contain(cardRowId).And.NotContain(referenceRowId);
            found["Accounts"].Should().Contain(accountId).And.Contain(encryptedAccountId);
            (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == cardRowId)).Payee
                .Should().Be("AMAZON " + Card, "the check reports and never rewrites");
        }
    }
}
