using FluentAssertions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Imports.Commands.PreviewImport;
using AllotJar.Application.Imports.Models;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;
using AllotJar.Infrastructure.Statements;

namespace AllotJar.IntegrationTests;

/// <summary>
/// The follow-up pass on transfers and the import against SQL Server (30 September 2026): the
/// import's ledger lock (#279 P3-2) and the ReceiptKnownBySourceReference migration's data step
/// (#279 P3-3).
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class TransfersImportFollowUpSqlTests
{
    private readonly SqlServerFixture _fixture;

    public TransfersImportFollowUpSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    private static readonly DateOnly Sep1 = new(2026, 9, 1);
    private static readonly DateOnly Sep10 = new(2026, 9, 10);

    private static string Camt(string reference, DateOnly date, decimal amount, bool credit) =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Document xmlns=\"urn:iso:std:iso:20022:tech:xsd:camt.053.001.08\"><BkToCstmrStmt><Stmt><Id>S</Id>"
        + "<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>"
        + $"<Ntry><Amt Ccy=\"EUR\">{amount:0.00}</Amt><CdtDbtInd>{(credit ? "CRDT" : "DBIT")}</CdtDbtInd><BookgDt><Dt>{date:yyyy-MM-dd}</Dt></BookgDt><AcctSvcrRef>{reference}</AcctSvcrRef></Ntry>"
        + "</Stmt></BkToCstmrStmt></Document>";

    // Two submits of one statement row that confirms a transfer's departure with a fee: without the
    // ledger lock the second one read the leg as still open and wrote a second fee row, which the
    // unique fee index turned into a 500. With it, the second waits for the first and skips the row.
    [Fact]
    public async Task A_double_submitted_fee_match_is_skipped_by_the_second_commit_not_failed()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var user = new CurrentUserStub(owner);
        Guid a, b, transferId;
        await using (var db = _fixture.CreateContext())
        {
            var source = new Account { OwnerId = owner, Name = "A", Currency = CurrencyCode.Eur, OpeningBalance = 1000m, OpeningDate = Sep1 };
            var dest = new Account { OwnerId = owner, Name = "B", Currency = CurrencyCode.Eur, OpeningBalance = 0m, OpeningDate = Sep1, DisplayOrder = 1 };
            db.Accounts.AddRange(source, dest);
            var line = new BudgetItem { Name = "Bank fees", PlannedAmount = 10m };
            db.BudgetMonths.Add(new BudgetMonth
            {
                OwnerId = owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
                Categories = new List<BudgetCategory> { new() { Name = "Charges", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { line } } },
            });
            await db.SaveChangesAsync();
            (a, b) = (source.Id, dest.Id);
            transferId = (await new CreateTransferCommandHandler(db, user).Handle(new CreateTransferCommand(Sep10, 100m, a, b), CancellationToken.None)).Id;

            var preview = await new PreviewImportCommandHandler(db, user,
                    new IStatementParser[] { new Camt053StatementParser(), new HsbcCsvStatementParser() }, new GenericCsvImporter())
                .Handle(new PreviewImportCommand(Camt("FEE-DBL", Sep10, 102m, false), StatementFormat.Camt053, AccountId: a), CancellationToken.None);
            var row = preview.Items.Single();
            var item = new CommitImportItem(row.Reference, row.Date, row.Payee, row.Amount, row.Currency, false, null, null,
                TransferAccountId: b, MatchTransferId: transferId, Fee: 2m, FeeBudgetItemId: line.Id);

            await using var first = _fixture.CreateContext();
            await using var second = _fixture.CreateContext();
            var results = await Task.WhenAll(
                new CommitImportCommandHandler(first, user).Handle(new CommitImportCommand(a, new[] { item }), CancellationToken.None),
                new CommitImportCommandHandler(second, user).Handle(new CommitImportCommand(a, new[] { item }), CancellationToken.None));

            results.Count(r => r.MatchedTransfers == 1).Should().Be(1);
            results.Count(r => r.SkippedDuplicates == 1).Should().Be(1);
        }

        await using var verify = _fixture.CreateContext();
        var transfer = await verify.Transactions.AsNoTracking().Include(t => t.Fee).SingleAsync(t => t.Id == transferId);
        transfer.BankReference.Should().Be("FEE-DBL");
        transfer.Fee!.Amount.Should().Be(2m);
        (await verify.Transactions.CountAsync(t => t.FeeForTransferId == transferId)).Should().Be(1);
    }

    private sealed class MarkRow
    {
        public Guid Id { get; set; }
        public bool ReceiptKnownBySourceReference { get; set; }
    }

    // The migration marks exactly the transfers the destination side honoured by their source
    // reference until now: received, with a source reference and no receipt reference.
    [Fact]
    public async Task The_migration_marks_received_transfers_with_only_a_source_reference()
    {
        var connection = new SqlConnectionStringBuilder(_fixture.ConnectionString)
        {
            InitialCatalog = $"AllotJar_ReceiptMark_{Guid.NewGuid():N}",
        }.ConnectionString;
        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseSqlServer(connection).Options;
        await using var db = new ApplicationDbContext(options);
        try
        {
            var migrations = db.Database.GetMigrations().ToList();
            var ours = migrations.FindIndex(m => m.EndsWith("_ReceiptKnownBySourceReference", StringComparison.Ordinal));
            ours.Should().BePositive();
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync(migrations[ours - 1]);

            var owner = "o";
            var a = Guid.NewGuid();
            var b = Guid.NewGuid();
            foreach (var (id, name) in new[] { (a, "A"), (b, "B") })
            {
                await db.Database.ExecuteSqlRawAsync(
                    "INSERT INTO Accounts (Id, OwnerId, Name, Type, Currency, OpeningBalance, OpeningDate, DisplayOrder) VALUES ({0}, {1}, {2}, 0, 'EUR', 1000, '2026-01-01', 0)",
                    id, owner, name);
            }
            var legacy = Guid.NewGuid();
            var byHand = Guid.NewGuid();
            var withReceiptRef = Guid.NewGuid();
            var inTransit = Guid.NewGuid();
            var noReference = Guid.NewGuid();
            var expense = Guid.NewGuid();
            async Task Insert(Guid id, int type, string? bankRef, string? receiptRef, bool received) =>
                await db.Database.ExecuteSqlRawAsync(@"
INSERT INTO Transactions (Id, OwnerId, AccountId, TransferAccountId, Amount, Currency, FxPending, Type, Date, DepartedOn, ReceivedOn, BankReference, ReceiptBankReference, Payee)
VALUES ({0}, {1}, {2}, {3}, 100, 'EUR', 0, {4}, '2026-06-10', {5}, {6}, {7}, {8}, 'Row')",
                    id, owner, a, type == 2 ? b : null, type,
                    type == 2 ? "2026-06-10" : null, received ? "2026-06-10" : null,
                    bankRef, receiptRef);
            await Insert(legacy, 2, "LEGACY", null, received: true);
            await Insert(byHand, 2, "HAND", null, received: true);
            await Insert(withReceiptRef, 2, "SRC", "DEST", received: true);
            await Insert(inTransit, 2, "OPEN", null, received: false);
            await Insert(noReference, 2, null, null, received: true);
            await Insert(expense, 0, "EXP", null, received: false);

            await migrator.MigrateAsync();

            var rows = await db.Database.SqlQueryRaw<MarkRow>("SELECT Id, ReceiptKnownBySourceReference FROM Transactions")
                .ToDictionaryAsync(r => r.Id, r => r.ReceiptKnownBySourceReference);
            rows[legacy].Should().BeTrue();
            rows[byHand].Should().BeTrue("a receipt confirmed by hand before this change can't be told apart; it keeps today's behaviour");
            rows[withReceiptRef].Should().BeFalse();
            rows[inTransit].Should().BeFalse();
            rows[noReference].Should().BeFalse();
            rows[expense].Should().BeFalse();
        }
        finally
        {
            await db.Database.EnsureDeletedAsync();
        }
    }
}
