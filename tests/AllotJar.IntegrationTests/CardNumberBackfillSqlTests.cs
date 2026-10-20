using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Compliance fix 12 on real SQL Server: the startup backfill finds a card number stored before
/// every save masked them (its 13-digit LIKE prefilter must translate and match), masks it, leaves
/// the bank reference alone, and the statement imported again is still recognised as a duplicate.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class CardNumberBackfillSqlTests
{
    private const string Card = "4111111111111111";
    private const string Masked = "••••••••••••1111";

    private const string Statement = $"""
        19/06/2026,AMAZON MKTP {Card}   * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00
        17/06/2026,PLANET PLAY RESTAURA 15/06/2026 •••• •••• •••• 4242 -67.75 EUR,-67.75
        """;

    private readonly SqlServerFixture _fixture;

    public CardNumberBackfillSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Backfill_MasksTextStoredBeforeTheFix_AndTheStatementIsStillADuplicate()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var entry = new HsbcCsvStatementParser().Parse(Statement).Entries[0];
        Guid accountId, rowId;
        await using (var db = _fixture.CreateContext())
        {
            var account = new Account { OwnerId = owner, Name = "Current", Currency = CurrencyCode.Eur };
            db.Accounts.Add(account);
            var row = new Transaction
            {
                OwnerId = owner, Account = account, Type = TransactionType.Expense, Amount = entry.Amount,
                Currency = CurrencyCode.Eur, Date = entry.BookingDate, Payee = "placeholder",
                BankReference = entry.Reference,
            };
            db.Transactions.Add(row);
            await db.SaveChangesAsync();
            (accountId, rowId) = (account.Id, row.Id);

            // What an import before fix 12 stored: the bank's text whole. Every save masks now, so
            // put it back with SQL, as it sits in production today.
            await db.Database.ExecuteSqlAsync(
                $"UPDATE Transactions SET Payee = {entry.Payee}, Notes = {"card 4111 1111 1111 1111"} WHERE Id = {rowId}");
            await db.Database.ExecuteSqlAsync(
                $"UPDATE Accounts SET Name = {"Visa " + Card} WHERE Id = {accountId}");
        }

        await using (var db = _fixture.CreateContext())
        {
            (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == rowId)).Payee.Should().Contain(Card);

            var masked = await CardNumberBackfill.BackfillAsync(db);

            masked.Should().BeGreaterThanOrEqualTo(3);
            (await CardNumberBackfill.BackfillAsync(db)).Should().Be(0, "a second run finds nothing to mask");
        }

        await using (var db = _fixture.CreateContext())
        {
            var stored = await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == rowId);
            stored.Payee.Should().Be($"AMAZON MKTP {Masked}");
            stored.Notes.Should().Be("card •••• •••• •••• 1111");
            stored.BankReference.Should().Be(entry.Reference, "references are never masked");
            (await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == accountId)).Name.Should().Be($"Visa {Masked}");

            var preview = await new PreviewImportCommandHandler(db, new CurrentUserStub(owner),
                    new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
                    new GenericCsvImporter())
                .Handle(new PreviewImportCommand(Statement, StatementFormat.HsbcCsv, AccountId: accountId), CancellationToken.None);
            preview.SkippedDuplicates.Should().Be(1);
            preview.Items.Should().ContainSingle(i => i.Payee == "PLANET PLAY RESTAURA");
        }
    }
}
