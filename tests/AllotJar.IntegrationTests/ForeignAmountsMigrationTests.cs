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
/// pinned on a real database holding rows as the old app left them (Christopher's "Keep counting",
/// 29 Sep 2026). The old rate lookup converted a row into its month's currency, or into EUR when
/// that month had no budget; a counted row counted Amount x ExchangeRate. After the migration a
/// row that counted a figure in the budget currency keeps counting exactly that figure; one whose
/// figure was in another currency waits for the user's amount; a row on an account kept in another
/// currency keeps that account's money and counts its figure beside it (Christopher's "Support
/// them", 29 Sep 2026); nothing is relabelled 1:1. Each
/// test uses its own throwaway database, migrated to the migration before ForeignAmounts, seeded
/// by SQL, then migrated to the latest.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class ForeignAmountsMigrationTests
{
    private readonly SqlServerFixture _fixture;

    public ForeignAmountsMigrationTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed record Row(decimal Amount, string Currency, bool FxPending, decimal? OriginalAmount, string? OriginalCurrency, decimal? BudgetAmount);

    private sealed class RowWithId
    {
        public Guid Id { get; set; }
        public decimal Amount { get; set; }
        public string Currency { get; set; } = string.Empty;
        public bool FxPending { get; set; }
        public decimal? OriginalAmount { get; set; }
        public string? OriginalCurrency { get; set; }
        public decimal? BudgetAmount { get; set; }
    }

    private sealed class SliceRow
    {
        public decimal Amount { get; set; }
        public decimal? BudgetAmount { get; set; }
    }

    private delegate Task Insert(Guid id, string owner, Guid? account, decimal amount, string currency, decimal rate,
        bool pending, int type = 0, Guid? to = null, string date = "2026-06-10");

    /// <summary>Migrates a fresh database to just before ForeignAmounts, seeds it, then runs the
    /// rest (or hands the migrator to <paramref name="check"/> when it expects a failure).</summary>
    private async Task Run(Func<ApplicationDbContext, Insert, Task> seed, Func<ApplicationDbContext, IMigrator, Task> check)
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

            async Task InsertRow(Guid id, string owner, Guid? account, decimal amount, string currency, decimal rate,
                bool pending, int type = 0, Guid? to = null, string date = "2026-06-10") =>
                await db.Database.ExecuteSqlRawAsync(@"
INSERT INTO Transactions (Id, OwnerId, AccountId, TransferAccountId, Amount, Currency, ExchangeRate, FxPending, Type, Date, DepartedOn, Payee)
VALUES (@id, @owner, @account, @to, @amount, @currency, @rate, @pending, @type, @date, @departed, 'Row')",
                    new SqlParameter("@id", id),
                    new SqlParameter("@owner", owner),
                    new SqlParameter("@account", SqlDbType.UniqueIdentifier) { Value = (object?)account ?? DBNull.Value },
                    new SqlParameter("@to", SqlDbType.UniqueIdentifier) { Value = (object?)to ?? DBNull.Value },
                    new SqlParameter("@amount", amount),
                    new SqlParameter("@currency", currency),
                    new SqlParameter("@rate", rate),
                    new SqlParameter("@pending", pending),
                    new SqlParameter("@type", type),
                    new SqlParameter("@date", SqlDbType.Date) { Value = DateTime.Parse(date) },
                    new SqlParameter("@departed", SqlDbType.Date) { Value = type == 2 ? DateTime.Parse(date) : DBNull.Value });

            await seed(db, InsertRow);
            await check(db, migrator);
        }
        finally
        {
            await db.Database.EnsureDeletedAsync();
        }
    }

    private static Task<Dictionary<Guid, Row>> ReadRows(ApplicationDbContext db) =>
        db.Database.SqlQueryRaw<RowWithId>(
                "SELECT Id, Amount, Currency, FxPending, OriginalAmount, OriginalCurrency, BudgetAmount FROM Transactions")
            .ToDictionaryAsync(r => r.Id, r => new Row(r.Amount, r.Currency, r.FxPending, r.OriginalAmount, r.OriginalCurrency, r.BudgetAmount));

    private static Task<List<SliceRow>> ReadSlices(ApplicationDbContext db, Guid transactionId) =>
        db.Database.SqlQueryRaw<SliceRow>(
                "SELECT Amount, BudgetAmount FROM TransactionSplits WHERE TransactionId = {0} ORDER BY Amount", transactionId)
            .ToListAsync();

    private static Task AddUser(ApplicationDbContext db, string id, string currency) =>
        db.Database.ExecuteSqlRawAsync(@"
INSERT INTO AspNetUsers (Id, UserName, Email, EmailConfirmed, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, PreferredCurrency)
VALUES ({0}, {1}, {1}, 1, 0, 0, 0, 0, {2})", id, $"{id}@example.test", currency);

    private static Task AddMonth(ApplicationDbContext db, string owner, int month, string currency) =>
        db.Database.ExecuteSqlRawAsync(
            "INSERT INTO BudgetMonths (Id, OwnerId, [Year], [Month], BaseCurrency) VALUES (NEWID(), {0}, 2026, {1}, {2})",
            owner, month, currency);

    private static Task AddAccount(ApplicationDbContext db, Guid id, string owner, string currency) =>
        db.Database.ExecuteSqlRawAsync(@"
INSERT INTO Accounts (Id, OwnerId, Name, Type, Currency, OpeningBalance, OpeningDate, DisplayOrder)
VALUES ({0}, {1}, {2}, 0, {3}, 1000, '2026-01-01', 0)", id, owner, $"{currency} account", currency);

    private static async Task AddSlices(ApplicationDbContext db, Guid transactionId, params decimal[] amounts)
    {
        foreach (var amount in amounts)
        {
            await db.Database.ExecuteSqlRawAsync(
                "INSERT INTO TransactionSplits (Id, TransactionId, Amount) VALUES ({0}, {1}, {2})", Guid.NewGuid(), transactionId, amount);
        }
    }

    [Fact]
    public async Task Converted_rows_keep_counting_the_figure_they_counted_and_the_rest_wait_or_count_as_they_are()
    {
        const string h = "w08-household-eur";
        const string g = "w08-household-gbp";
        var gbpAccount = Guid.NewGuid();
        var eurAccount = Guid.NewGuid();
        var converted = Guid.NewGuid();
        var convertedSplit = Guid.NewGuid();
        var typedAsBudgetFigure = Guid.NewGuid();
        var waiting = Guid.NewGuid();
        var onForeignAccount = Guid.NewGuid();
        var splitOnForeignAccount = Guid.NewGuid();
        var foreignRowOnBudgetAccount = Guid.NewGuid();
        var splitOnBudgetAccount = Guid.NewGuid();
        var waitingOnForeignAccount = Guid.NewGuid();
        var waitingInBudgetCurrency = Guid.NewGuid();
        var plain = Guid.NewGuid();
        var transfer = Guid.NewGuid();
        var gbpHousehold = Guid.NewGuid();

        await Run(async (db, insert) =>
        {
            await AddUser(db, h, "EUR");
            await AddUser(db, g, "GBP");
            await AddMonth(db, h, 6, "EUR");
            await AddAccount(db, gbpAccount, h, "GBP");
            await AddAccount(db, eurAccount, h, "EUR");

            await insert(converted, h, null, 100m, "GBP", 1.17m, false);
            await insert(convertedSplit, h, null, 10m, "USD", 1.123457m, false);
            await AddSlices(db, convertedSplit, 3.33m, 3.33m, 3.34m);
            // The old app's edit of a waiting row: the user typed the budget figure, rate 1.
            await insert(typedAsBudgetFigure, h, null, 64m, "USD", 1m, false);
            await insert(waiting, h, null, 40m, "USD", 1m, true);
            await insert(onForeignAccount, h, gbpAccount, 25m, "GBP", 1.2m, false);
            await insert(splitOnForeignAccount, h, gbpAccount, 10m, "GBP", 1.123457m, false);
            await AddSlices(db, splitOnForeignAccount, 3.33m, 3.33m, 3.34m);
            // Before #210 a row's currency could differ from its account's.
            await insert(foreignRowOnBudgetAccount, h, eurAccount, 45.50m, "GBP", 1.17m, false);
            await insert(splitOnBudgetAccount, h, eurAccount, 10m, "USD", 1.123457m, false);
            await AddSlices(db, splitOnBudgetAccount, 3.33m, 3.33m, 3.34m);
            await insert(waitingOnForeignAccount, h, gbpAccount, 7m, "GBP", 1m, true);
            await insert(waitingInBudgetCurrency, h, null, 12m, "EUR", 1m, true);
            await insert(plain, h, eurAccount, 30m, "EUR", 1m, false);
            await insert(transfer, h, eurAccount, 50m, "EUR", 1m, false, type: 2, to: eurAccount);
            await insert(gbpHousehold, g, null, 8m, "GBP", 1m, false);
        }, async (db, migrator) =>
        {
            await migrator.MigrateAsync();
            var rows = await ReadRows(db);

            rows[converted].Should().Be(new Row(117m, "EUR", false, 100m, "GBP", null), "it counted as 100 x 1.17");
            rows[convertedSplit].Should().Be(new Row(11.2346m, "EUR", false, 10m, "USD", null));
            rows[typedAsBudgetFigure].Should().Be(new Row(64m, "EUR", false, null, null, null),
                "at rate 1 the amount already was the budget figure; there is no foreign figure to keep");
            rows[waiting].Should().Be(new Row(40m, "USD", true, null, null, null), "a waiting row still waits for the user");
            // Christopher's "Support them" (29 Sep 2026): a row on an account kept in another
            // currency keeps its amount (the account's money) and keeps counting 25 x 1.2 beside it.
            rows[onForeignAccount].Should().Be(new Row(25m, "GBP", false, null, null, 30m));
            rows[splitOnForeignAccount].Should().Be(new Row(10m, "GBP", false, null, null, 11.2346m));
            // A foreign row on a budget-currency account (possible before #210): the account's money
            // stays as it is and the row keeps counting its figure beside it.
            rows[foreignRowOnBudgetAccount].Should().Be(new Row(45.50m, "GBP", false, null, null, 53.235m));
            rows[splitOnBudgetAccount].Should().Be(new Row(10m, "USD", false, null, null, 11.2346m));
            rows[waitingOnForeignAccount].Should().Be(new Row(7m, "GBP", true, null, null, null));
            rows[waitingInBudgetCurrency].Should().Be(new Row(12m, "EUR", false, null, null, null));
            rows[plain].Should().Be(new Row(30m, "EUR", false, null, null, null));
            rows[transfer].Should().Be(new Row(50m, "EUR", false, null, null, null));
            rows[gbpHousehold].Should().Be(new Row(8m, "GBP", false, null, null, null), "GBP is that household's budget currency");

            var restated = await ReadSlices(db, convertedSplit);
            restated.Select(s => s.Amount).Should().Equal(3.7411m, 3.7411m, 3.7524m);
            restated.Sum(s => s.Amount).Should().Be(11.2346m, "the slices still add up to the restated amount");
            restated.Should().OnlyContain(s => s.BudgetAmount == null);

            // The account's money is not restated; the slices count their share of the figure.
            var onAccountSlices = await ReadSlices(db, splitOnForeignAccount);
            onAccountSlices.Select(s => s.Amount).Should().Equal(3.33m, 3.33m, 3.34m);
            onAccountSlices.Select(s => s.BudgetAmount).Should().Equal(3.7411m, 3.7411m, 3.7524m);

            var kept = await ReadSlices(db, splitOnBudgetAccount);
            kept.Select(s => s.Amount).Should().Equal(3.33m, 3.33m, 3.34m);
            kept.Select(s => s.BudgetAmount).Should().Equal(3.7411m, 3.7411m, 3.7524m);
            kept.Sum(s => s.BudgetAmount!.Value).Should().Be(11.2346m, "the slices' figures add up to the row's");
        });
    }

    /// <summary>
    /// A GBP household's rows dated in a month that had no budget: the old lookup converted them
    /// into EUR, its default, so their figures were never in pounds. A GBP row keeps its own
    /// amount (it is already in the budget currency; the old EUR figure was the mistake), and a
    /// USD row has no figure in pounds to keep, so it waits for the user instead of reading a
    /// USD-to-EUR figure as pounds. A row dated in a GBP month kept its GBP figure.
    /// </summary>
    [Fact]
    public async Task Rows_the_old_lookup_converted_into_its_EUR_default_are_never_read_as_the_budget_currency()
    {
        var gbpRow = Guid.NewGuid();
        var usdRow = Guid.NewGuid();
        var usdOnAccount = Guid.NewGuid();
        var usdInABudgetMonth = Guid.NewGuid();
        var usdAccount = Guid.NewGuid();
        await Run(async (db, insert) =>
        {
            await AddUser(db, "g", "GBP");
            await AddMonth(db, "g", 7, "GBP");
            await AddAccount(db, usdAccount, "g", "USD");
            // June 2026 has no budget month: the old lookup's base was EUR.
            await insert(gbpRow, "g", null, 100m, "GBP", 1.17m, false);
            await insert(usdRow, "g", null, 100m, "USD", 0.92m, false);
            await insert(usdOnAccount, "g", usdAccount, 50m, "USD", 0.92m, false);
            await insert(usdInABudgetMonth, "g", null, 100m, "USD", 0.79m, false, date: "2026-07-10");
        }, async (db, migrator) =>
        {
            await migrator.MigrateAsync();
            var rows = await ReadRows(db);
            rows[gbpRow].Should().Be(new Row(100m, "GBP", false, null, null, null));
            rows[usdRow].Should().Be(new Row(100m, "USD", true, null, null, null));
            rows[usdOnAccount].Should().Be(new Row(50m, "USD", true, null, null, null), "it can be confirmed like any waiting row");
            rows[usdInABudgetMonth].Should().Be(new Row(79m, "GBP", false, 100m, "USD", null));
        });
    }

    /// <summary>
    /// A household whose months are in more than one currency (on the old app a month with no
    /// earlier month took the creating login's preference) has no budget currency to keep
    /// counting in. The migration stops before changing anything rather than pick one.
    /// </summary>
    [Fact]
    public async Task A_household_with_months_in_two_currencies_stops_the_migration_before_anything_changes()
    {
        var row = Guid.NewGuid();
        await Run(async (db, insert) =>
        {
            await AddUser(db, "m", "EUR");
            await AddMonth(db, "m", 5, "GBP");
            await AddMonth(db, "m", 6, "EUR");
            await insert(row, "m", null, 20m, "USD", 0.92m, false);
        }, async (db, migrator) =>
        {
            var act = () => migrator.MigrateAsync();
            (await act.Should().ThrowAsync<SqlException>()).Which.Message.Should().Contain("more than one currency");

            var applied = await db.Database.GetAppliedMigrationsAsync();
            applied.Should().NotContain(m => m.EndsWith("_ForeignAmounts", StringComparison.Ordinal));
            var stillThere = await db.Database.SqlQueryRaw<decimal>(
                "SELECT ExchangeRate AS Value FROM Transactions WHERE Id = {0}", row).SingleAsync();
            stillThere.Should().Be(0.92m, "nothing was changed");
        });
    }
}
