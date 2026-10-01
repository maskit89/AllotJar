using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.IntegrationTests;

/// <summary>
/// D8 against SQL Server (1 October 2026 follow-ups): the statement account a row moved by hand
/// keeps (the <c>TransactionStatementAccount</c> migration's column) is read by the import's
/// query of known references, so its statement skips the row instead of offering it again.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class MoneyImportFollowUpsSqlTests
{
    private readonly SqlServerFixture _fixture;

    public MoneyImportFollowUpsSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);

    private static string Camt(string reference, DateOnly date, decimal amount) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + $"<Ntry><Amt Ccy=\"EUR\">{amount:0.00}</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt><AcctSvcrRef>{reference}</AcctSvcrRef></Ntry>"
        + "</Stmt></BkToCstmrStmt></Document>";

    [Fact]
    public async Task A_row_moved_by_hand_to_another_account_is_skipped_when_its_statement_is_imported_again()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var user = new CurrentUserStub(owner);
        var xml = Camt("MOVED-1", Sep10, 40m);
        Guid a, b, rowId;
        await using (var db = _fixture.CreateContext())
        {
            var source = new Account { OwnerId = owner, Name = "A", Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = Sep1 };
            var other = new Account { OwnerId = owner, Name = "B", Type = AccountType.Current, Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = Sep1, DisplayOrder = 1 };
            db.Accounts.AddRange(source, other);
            await db.SaveChangesAsync();
            (a, b) = (source.Id, other.Id);
        }

        await using (var db = _fixture.CreateContext())
        {
            var preview = await Preview(db, user, xml, a);
            var row = preview.Items.Single();
            await new CommitImportCommandHandler(db, user).Handle(
                new CommitImportCommand(a, new[] { new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null) }),
                CancellationToken.None);
            rowId = (await db.Transactions.AsNoTracking().SingleAsync(t => t.OwnerId == owner && t.BankReference == "MOVED-1")).Id;
        }

        await using (var db = _fixture.CreateContext())
        {
            await new UpdateTransactionCommandHandler(db, user).Handle(
                new UpdateTransactionCommand(rowId, Sep10, "Shop", 40m, TransactionType.Expense, b), CancellationToken.None);
        }

        await using (var db = _fixture.CreateContext())
        {
            (await db.Transactions.AsNoTracking().SingleAsync(t => t.Id == rowId)).StatementAccountId.Should().Be(a);
            (await Preview(db, user, xml, a)).NewCount.Should().Be(0);
        }
    }

    private static Task<ImportPreviewResult> Preview(AllotJar.Infrastructure.Persistence.ApplicationDbContext db, ICurrentUser user, string xml, Guid accountId) =>
        new PreviewImportCommandHandler(db, user,
                new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
            .Handle(new PreviewImportCommand(xml, StatementFormat.Camt053, AccountId: accountId), CancellationToken.None);
}
