using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.Application.Tests.Imports;

/// <summary>
/// Compliance fix 12: a card number in a statement's description or in typed text is never
/// stored, and masking it changes neither import duplicate detection nor transfer matching.
/// </summary>
public class CardNumberImportTests
{
    private const string Card = "4111111111111111";
    private const string Masked = "••••••••••••1111";

    // A statement that printed a whole card number in the description.
    private const string Statement = $"""
        19/06/2026,AMAZON MKTP {Card}   * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00
        17/06/2026,PLANET PLAY RESTAURA 15/06/2026 •••• •••• •••• 4242 -67.75 EUR,-67.75
        """;

    private const string SourceStatement = $"""
        30/09/2026,TRANSFER TO SAVINGS {Card} * 30/09/2026 •••• •••• •••• 4242 -100.00 EUR,-100.00
        """;

    private const string DestinationStatement = $"""
        01/10/2026,TRANSFER FROM CURRENT {Card} * 01/10/2026 •••• •••• •••• 4242 100.00 EUR,100.00
        """;

    private static PreviewImportCommandHandler NewPreview(ApplicationDbContext db) =>
        new(db, new CurrentUserStub("user-1"),
            new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() },
            new GenericCsvImporter());

    private static CommitImportCommandHandler NewCommit(ApplicationDbContext db) =>
        new(db, new CurrentUserStub("user-1"));

    private static Account SeedAccount(ApplicationDbContext db, string name, decimal opening)
    {
        var account = new Account
        {
            OwnerId = "user-1", Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
            OpeningBalance = opening, OpeningDate = new DateOnly(2026, 6, 1),
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static Task<ImportPreviewResult> PreviewAsync(ApplicationDbContext db, string content, Guid accountId) =>
        NewPreview(db).Handle(new PreviewImportCommand(content, StatementFormat.HsbcCsv, AccountId: accountId), CancellationToken.None);

    private static CommitImportItem Plain(ImportCandidate row) =>
        new(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, row.IsCredit, null, null);

    [Fact]
    public async Task Preview_MasksTheCardNumber()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 500m);

        var preview = await PreviewAsync(db, Statement, account.Id);

        preview.Items.Select(i => i.Payee).Should().Equal($"AMAZON MKTP {Masked}", "PLANET PLAY RESTAURA");
    }

    [Fact]
    public void TheReference_IsHashedOverTheMaskedText_SoNoCardNumberCanBeRecoveredFromIt()
    {
        var parser = new HsbcCsvStatementParser();
        var withCard = parser.Parse(Statement).Entries;
        var alreadyMasked = parser.Parse(Statement.Replace(Card, Masked)).Entries;

        // The reference is hashed over what the same row printed already masked reads (marked "#m"
        // so the two never share one): it holds nothing the masked payee doesn't. A row with no card number keeps its reference to the character.
        withCard[0].Reference.Should().Be(alreadyMasked[0].Reference.Replace("#0", "#m0"));
        withCard[1].Reference.Should().Be(alreadyMasked[1].Reference);
        withCard[1].LegacyReference.Should().BeNull();
        // What imports before the fix stored (hashed over the bank's text) is kept to recognise them.
        withCard[0].LegacyReference.Should().NotBeNull().And.NotBe(withCard[0].Reference);
    }

    [Fact]
    public async Task ThePurchasePrintedOnceWithTheFullCard_AndOnceMasked_IsTwoRows()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 500m);
        var statement = $"""
            19/06/2026,AMAZON MKTP {Card}   * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00
            19/06/2026,AMAZON MKTP {Masked}   * 17/06/2026 •••• •••• •••• 4242 -35.00 EUR,-35.00
            """;

        var preview = await PreviewAsync(db, statement, account.Id);

        preview.Items.Should().HaveCount(2, "two printed rows are two transactions");
        preview.Items.Select(i => i.Reference).Should().OnlyHaveUniqueItems();
        preview.SkippedDuplicates.Should().Be(0);
        await NewCommit(db).Handle(new CommitImportCommand(account.Id, preview.Items.Select(Plain).ToList()), CancellationToken.None);
        (await db.Transactions.CountAsync()).Should().Be(2);
        (await PreviewAsync(db, statement, account.Id)).SkippedDuplicates.Should().Be(2);
    }

    [Theory]
    [InlineData(StatementFormat.HsbcCsv)]
    [InlineData(StatementFormat.GenericCsv)]
    [InlineData(StatementFormat.Camt053)]
    public async Task ARowImportedBeforeTheFix_UnderItsOldReference_IsStillADuplicate(StatementFormat format)
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 500m);
        var content = format switch
        {
            StatementFormat.HsbcCsv => Statement,
            StatementFormat.GenericCsv => $"""
                Date,Description,Amount
                2026-06-19,AMAZON MKTP {Card},-35.00
                2026-06-17,PLANET PLAY RESTAURA,-67.75
                """,
            _ => Camt053Samples.TwoEurEntries
                .Replace("<AcctSvcrRef>REF-RENT-001</AcctSvcrRef>", "")
                .Replace("Landlord GmbH", $"Landlord {Card}"),
        };
        var first = (await NewPreview(db).Handle(
            new PreviewImportCommand(content, format, AccountId: account.Id), CancellationToken.None)).Items[0];
        first.Payee.Should().Contain(Masked);
        var parsed = format switch
        {
            StatementFormat.HsbcCsv => new HsbcCsvStatementParser().Parse(content),
            StatementFormat.Camt053 => new Camt053StatementParser().Parse(content),
            _ => new GenericCsvImporter().Parse(content, new GenericCsvImporter().Detect(content).Suggested),
        };
        var legacy = parsed.Entries.Single(e => e.Reference == first.Reference).LegacyReference;
        legacy.Should().NotBeNull();

        // As an import before fix 12 stored it: under the reference hashed over the bank's text.
        db.Transactions.Add(new Transaction
        {
            OwnerId = "user-1", AccountId = account.Id, Type = TransactionType.Expense, Amount = first.Amount,
            Currency = CurrencyCode.Eur, Date = first.Date, Payee = first.Payee, BankReference = legacy,
        });
        await db.SaveChangesAsync();

        var again = await NewPreview(db).Handle(
            new PreviewImportCommand(content, format, AccountId: account.Id), CancellationToken.None);

        again.SkippedDuplicates.Should().Be(1);
        again.Items.Should().NotContain(i => i.Reference == first.Reference);
    }

    [Fact]
    public async Task Commit_StoresTheMaskedPayee_AndImportingAgainSkipsBothRows()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "Current", 500m);
        var preview = await PreviewAsync(db, Statement, account.Id);

        // Even a client that sent the bank's text back unmasked stores it masked.
        var items = preview.Items.Select(Plain)
            .Select(i => i.Payee.StartsWith("AMAZON") ? i with { Payee = $"AMAZON MKTP {Card}" } : i)
            .ToList();
        await NewCommit(db).Handle(new CommitImportCommand(account.Id, items), CancellationToken.None);

        (await db.Transactions.Select(t => t.Payee).ToListAsync())
            .Should().BeEquivalentTo($"AMAZON MKTP {Masked}", "PLANET PLAY RESTAURA");

        var again = await PreviewAsync(db, Statement, account.Id);
        again.SkippedDuplicates.Should().Be(2);
        again.Items.Should().BeEmpty();
    }

    [Fact]
    public async Task ATransferWithACardNumberInItsText_IsStillMatchedByTheOtherStatement()
    {
        await using var db = NewContext();
        var a = SeedAccount(db, "A", 1000m);
        var b = SeedAccount(db, "B", 200m);
        var source = (await PreviewAsync(db, SourceStatement, a.Id)).Items.Single();
        await NewCommit(db).Handle(new CommitImportCommand(a.Id, new[]
        {
            Plain(source) with { TransferAccountId = b.Id },
        }), CancellationToken.None);
        var transfer = await db.Transactions.SingleAsync();
        transfer.Payee.Should().Be($"TRANSFER TO SAVINGS {Masked}");

        var row = (await PreviewAsync(db, DestinationStatement, b.Id)).Items.Single();

        row.Payee.Should().Be($"TRANSFER FROM CURRENT {Masked}");
        row.TransferMatches.Should().ContainSingle(m => m.TransferId == transfer.Id);
        (await PreviewAsync(db, SourceStatement, a.Id)).SkippedDuplicates.Should().Be(1);
    }
}
