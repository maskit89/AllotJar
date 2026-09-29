using System.Data;
using FluentAssertions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// The W08 ForeignAmounts migration runs against production data at deploy, so its data step is
/// pinned on a real database holding rows as the old rate lookup left them (Christopher's "Keep
/// counting", 29 Sep 2026): a converted row keeps counting at the figure it counted at, now as its
/// budget-currency amount, with split slices restated to still add up; a converted row on an
/// account kept in another currency waits instead; a row already in the budget currency counts;
/// waiting rows and transfers are left alone. Uses its own throwaway database, migrated to the
/// migration before ForeignAmounts, seeded by SQL, then migrated to the latest.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class ForeignAmountsMigrationTests
{
    private readonly SqlServerFixture _fixture;

    public ForeignAmountsMigrationTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed record Row(decimal Amount, string Currency, bool FxPending, decimal? OriginalAmount, string? OriginalCurrency);

    [Fact]
    public async Task Converted_rows_keep_counting_in_the_budget_currency_and_the_rest_wait_or_count_as_they_are()
    {
        var connection = new SqlConnectionStringBuilder(_fixture.ConnectionString)
        {
            InitialCatalog = $"AllotJar_W08Migration_{Guid.NewGuid():N}",
        }.ConnectionString;
        var options = new DbContextOptionsBuilder<ApplicationDbContext>().UseSqlServer(connection).Options;

        await using var db = new ApplicationDbContext(options);
        try
        {
            var migrations = db.Database.GetMigrations().ToList();
            var ours = migrations.FindIndex(m => m.EndsWith("_ForeignAmounts", StringComparison.Ordinal));
            ours.Should().BePositive();
            var migrator = db.GetService<IMigrator>();
            await migrator.MigrateAsync(migrations[ours - 1]);

            // Household H (EUR budget month) and household G (no month; its owner chose GBP).
            const string h = "w08-household-eur";
            const string g = "w08-household-gbp";
            var gbpAccount = Guid.NewGuid();
            var eurAccount = Guid.NewGuid();
            var converted = Guid.NewGuid();
            var convertedSplit = Guid.NewGuid();
            var waiting = Guid.NewGuid();
            var onForeignAccount = Guid.NewGuid();
            var waitingInBudgetCurrency = Guid.NewGuid();
            var plain = Guid.NewGuid();
            var transfer = Guid.NewGuid();
            var gbpHousehold = Guid.NewGuid();
            var slices = new[] { Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid() };

            await db.Database.ExecuteSqlRawAsync(@"
INSERT INTO AspNetUsers (Id, UserName, Email, EmailConfirmed, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, PreferredCurrency)
VALUES ({0}, 'h@example.test', 'h@example.test', 1, 0, 0, 0, 0, 'EUR'),
       ({1}, 'g@example.test', 'g@example.test', 1, 0, 0, 0, 0, 'GBP');
INSERT INTO BudgetMonths (Id, OwnerId, [Year], [Month], BaseCurrency) VALUES (NEWID(), {0}, 2026, 6, 'EUR');
INSERT INTO Accounts (Id, OwnerId, Name, Type, Currency, OpeningBalance, OpeningDate, DisplayOrder)
VALUES ({2}, {0}, 'UK card', 0, 'GBP', 500, '2026-01-01', 0),
       ({3}, {0}, 'Joint', 0, 'EUR', 1000, '2026-01-01', 1);",
                h, g, gbpAccount, eurAccount);

            async Task Insert(Guid id, string owner, Guid? account, decimal amount, string currency, decimal rate, bool pending,
                int type = 0, Guid? to = null) =>
                await db.Database.ExecuteSqlRawAsync(@"
INSERT INTO Transactions (Id, OwnerId, AccountId, TransferAccountId, Amount, Currency, ExchangeRate, FxPending, Type, Date, DepartedOn, Payee)
VALUES (@id, @owner, @account, @to, @amount, @currency, @rate, @pending, @type, '2026-06-10', @departed, 'Row')",
                    new SqlParameter("@id", id),
                    new SqlParameter("@owner", owner),
                    new SqlParameter("@account", SqlDbType.UniqueIdentifier) { Value = (object?)account ?? DBNull.Value },
                    new SqlParameter("@to", SqlDbType.UniqueIdentifier) { Value = (object?)to ?? DBNull.Value },
                    new SqlParameter("@amount", amount),
                    new SqlParameter("@currency", currency),
                    new SqlParameter("@rate", rate),
                    new SqlParameter("@pending", pending),
                    new SqlParameter("@type", type),
                    new SqlParameter("@departed", SqlDbType.Date) { Value = type == 2 ? new DateTime(2026, 6, 10) : DBNull.Value });

            await Insert(converted, h, null, 100m, "GBP", 1.17m, false);
            await Insert(convertedSplit, h, null, 10m, "USD", 1.123457m, false);
            await Insert(waiting, h, null, 40m, "USD", 1m, true);
            await Insert(onForeignAccount, h, gbpAccount, 25m, "GBP", 1.2m, false);
            await Insert(waitingInBudgetCurrency, h, null, 12m, "EUR", 1m, true);
            await Insert(plain, h, eurAccount, 30m, "EUR", 1m, false);
            await Insert(transfer, h, eurAccount, 50m, "EUR", 1m, false, type: 2, to: eurAccount);
            await Insert(gbpHousehold, g, null, 8m, "GBP", 1m, false);
            foreach (var (slice, amount) in slices.Zip(new[] { 3.33m, 3.33m, 3.34m }))
            {
                await db.Database.ExecuteSqlRawAsync(
                    "INSERT INTO TransactionSplits (Id, TransactionId, Amount) VALUES ({0}, {1}, {2})",
                    slice, convertedSplit, amount);
            }

            await migrator.MigrateAsync();

            var rows = await db.Database.SqlQueryRaw<RowWithId>(
                    "SELECT Id, Amount, Currency, FxPending, OriginalAmount, OriginalCurrency FROM Transactions")
                .ToDictionaryAsync(r => r.Id, r => new Row(r.Amount, r.Currency, r.FxPending, r.OriginalAmount, r.OriginalCurrency));

            rows[converted].Should().Be(new Row(117m, "EUR", false, 100m, "GBP"), "it counted as 100 x 1.17");
            rows[convertedSplit].Should().Be(new Row(11.2346m, "EUR", false, 10m, "USD"));
            rows[waiting].Should().Be(new Row(40m, "USD", true, null, null), "a waiting row still waits for the user");
            rows[onForeignAccount].Should().Be(new Row(25m, "GBP", true, null, null), "its account's money is not restated");
            rows[waitingInBudgetCurrency].Should().Be(new Row(12m, "EUR", false, null, null));
            rows[plain].Should().Be(new Row(30m, "EUR", false, null, null));
            rows[transfer].Should().Be(new Row(50m, "EUR", false, null, null));
            rows[gbpHousehold].Should().Be(new Row(8m, "GBP", false, null, null), "GBP is that household's budget currency");

            var sliceAmounts = await db.Database.SqlQueryRaw<decimal>(
                    "SELECT Amount AS Value FROM TransactionSplits WHERE TransactionId = {0} ORDER BY Amount", convertedSplit)
                .ToListAsync();
            sliceAmounts.Should().Equal(3.7411m, 3.7411m, 3.7524m);
            sliceAmounts.Sum().Should().Be(11.2346m, "the slices still add up to the restated amount");
        }
        finally
        {
            await db.Database.EnsureDeletedAsync();
        }
    }

    private sealed class RowWithId
    {
        public Guid Id { get; set; }
        public decimal Amount { get; set; }
        public string Currency { get; set; } = string.Empty;
        public bool FxPending { get; set; }
        public decimal? OriginalAmount { get; set; }
        public string? OriginalCurrency { get; set; }
    }
}
