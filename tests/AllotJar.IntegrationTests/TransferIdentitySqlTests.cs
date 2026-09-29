using FluentAssertions;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.DependencyInjection;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// W07's relational guarantees that EF InMemory cannot see: a return only on a departed,
/// unreceived transfer on or after its departure; one fee row per transfer; one return reference
/// per statement account; one stored jar return per transfer, never orphaned; a transfer edit's
/// lock on every account it touches; and the migration moving allocation keys out of the bank
/// reference.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class TransferIdentitySqlTests
{
    private static readonly DateOnly Departed = new(2026, 9, 10);
    private readonly SqlServerFixture _fixture;

    public TransferIdentitySqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static async Task<(Account A, Account B)> SeedAccountsAsync(ApplicationDbContext db, string owner)
    {
        var a = new Account { OwnerId = owner, Name = "A", Currency = CurrencyCode.From("EUR"), OpeningDate = new DateOnly(2026, 1, 1) };
        var b = new Account { OwnerId = owner, Name = "B", Currency = CurrencyCode.From("EUR"), OpeningDate = new DateOnly(2026, 1, 1) };
        db.Accounts.AddRange(a, b);
        await db.SaveChangesAsync();
        return (a, b);
    }

    private static Transaction Transfer(string owner, Account from, Account to, DateOnly? receivedOn = null, DateOnly? returnedOn = null) => new()
    {
        OwnerId = owner, Type = TransactionType.Transfer, Amount = 100m, Currency = CurrencyCode.From("EUR"),
        Date = Departed, DepartedOn = Departed, ReceivedOn = receivedOn, ReturnedOn = returnedOn,
        AccountId = from.Id, TransferAccountId = to.Id, Payee = "TRANSFER",
    };

    public static TheoryData<int?, int> InvalidReturns => new()
    {
        { 12, 11 },   // received and returned
        { null, -1 }, // back before it left
    };

    [Theory]
    [MemberData(nameof(InvalidReturns))]
    public async Task Database_refuses_a_return_on_a_received_transfer_or_before_the_departure(int? receivedDay, int returnOffset)
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);

        db.Transactions.Add(Transfer(owner, a, b,
            receivedOn: receivedDay is int day ? new DateOnly(2026, 9, day) : null,
            returnedOn: Departed.AddDays(returnOffset)));
        var act = () => db.SaveChangesAsync();

        // CK_Transactions_TransferReturn.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Database_accepts_a_return_on_the_departure_day_or_later()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);

        db.Transactions.Add(Transfer(owner, a, b, returnedOn: Departed));
        db.Transactions.Add(Transfer(owner, a, b, returnedOn: Departed.AddDays(3)));

        var act = () => db.SaveChangesAsync();
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Database_refuses_a_second_fee_row_for_one_transfer()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);
        var transfer = Transfer(owner, a, b);
        db.Transactions.Add(transfer);
        await db.SaveChangesAsync();

        Transaction Fee() => new()
        {
            OwnerId = owner, Type = TransactionType.Expense, Amount = 2m, Currency = CurrencyCode.From("EUR"),
            Date = Departed, AccountId = a.Id, Payee = "Fee: TRANSFER", FeeForTransferId = transfer.Id,
        };
        await using (var first = _fixture.CreateContext())
        {
            first.Transactions.Add(Fee());
            await first.SaveChangesAsync();
        }

        await using var second = _fixture.CreateContext();
        second.Transactions.Add(Fee());
        var act = () => second.SaveChangesAsync();
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Database_refuses_deleting_a_transfer_that_still_has_its_fee_row()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);
        var transfer = Transfer(owner, a, b);
        db.Transactions.Add(transfer);
        db.Transactions.Add(new Transaction
        {
            OwnerId = owner, Type = TransactionType.Expense, Amount = 2m, Currency = CurrencyCode.From("EUR"),
            Date = Departed, AccountId = a.Id, Payee = "Fee: TRANSFER", FeeForTransfer = transfer,
        });
        await db.SaveChangesAsync();

        await using var other = _fixture.CreateContext();
        other.Transactions.Remove(await other.Transactions.SingleAsync(t => t.Id == transfer.Id));
        var act = () => other.SaveChangesAsync();

        // Restrict: the handlers remove the fee with its transfer; the schema never orphans one.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Database_refuses_a_duplicate_return_reference_on_the_same_source_account()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);
        var first = Transfer(owner, a, b, returnedOn: Departed.AddDays(2));
        first.ReturnBankReference = "A-BACK-1";
        db.Transactions.Add(first);
        await db.SaveChangesAsync();

        await using var second = _fixture.CreateContext();
        var again = Transfer(owner, a, b, returnedOn: Departed.AddDays(2));
        again.ReturnBankReference = "a-back-1";
        second.Transactions.Add(again);
        var act = () => second.SaveChangesAsync();
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    private static JarAllocation ReturnOp(string owner, Account source, Transaction transfer) => new()
    {
        OwnerId = owner, AccountId = source.Id, Kind = JarAllocationKind.Return, Date = transfer.ReturnedOn!.Value,
        ReturnOfTransferId = transfer.Id, CreatedUtc = DateTime.UtcNow,
        Postings = new List<JarAllocationPosting> { new() { JarId = null, Amount = 0m } },
    };

    [Fact]
    public async Task Database_keeps_one_jar_return_per_transfer_and_never_orphans_it()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);
        var transfer = Transfer(owner, a, b, returnedOn: Departed.AddDays(2));
        db.Transactions.Add(transfer);
        db.JarAllocations.Add(ReturnOp(owner, a, transfer));
        await db.SaveChangesAsync();

        await using (var second = _fixture.CreateContext())
        {
            second.JarAllocations.Add(ReturnOp(owner, a, transfer));
            var twice = () => second.SaveChangesAsync();
            await twice.Should().ThrowAsync<DbUpdateException>("IX_JarAllocations_ReturnOfTransferId");
        }

        await using var other = _fixture.CreateContext();
        other.Transactions.Remove(await other.Transactions.SingleAsync(t => t.Id == transfer.Id));
        var orphan = () => other.SaveChangesAsync();
        // No action: TransferReturns.ClearAsync removes the return with its transfer.
        await orphan.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task A_transfer_edit_holds_every_account_it_touches_until_it_commits()
    {
        // P2-5: an edit can take money from its destination too, so a payment from that account
        // waits for it instead of validating against a read the edit is about to change.
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var (a, b) = await SeedAccountsAsync(db, owner);

        await using var edit = _fixture.CreateContext();
        var write = await edit.BeginLedgerWriteAsync(new[] { b.Id, a.Id });
        await using var payment = _fixture.CreateContext();
        var waiting = Task.Run(async () =>
        {
            await using var other = await payment.BeginLedgerWriteAsync(b.Id);
            await other!.CommitAsync(CancellationToken.None);
        });

        await Task.WhenAny(waiting, Task.Delay(TimeSpan.FromSeconds(1)));
        waiting.IsCompleted.Should().BeFalse("the payment from B waits on the edit's lock");
        await write!.CommitAsync(CancellationToken.None);
        await write.DisposeAsync();
        await waiting.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public async Task Migration_moves_allocation_keys_out_of_the_bank_reference_and_back_on_rollback()
    {
        // A database of its own: migrated to just before W07, seeded, then taken forward and back.
        var connection = new SqlConnectionStringBuilder(_fixture.ConnectionString)
        {
            InitialCatalog = $"AllotJar_W07_{Guid.NewGuid():N}",
        }.ConnectionString;
        await using var db = new ApplicationDbContext(
            new DbContextOptionsBuilder<ApplicationDbContext>().UseSqlServer(connection).Options);
        var migrations = db.Database.GetMigrations().ToList();
        var w07 = migrations.Single(m => m.EndsWith("_TransferReturnsFeesAndAllocationKeys", StringComparison.Ordinal));
        var before = migrations[migrations.IndexOf(w07) - 1];
        var migrator = db.GetInfrastructure().GetRequiredService<IMigrator>();
        try
        {
            await migrator.MigrateAsync(before);

            var owner = NewOwner();
            Guid a = Guid.NewGuid(), b = Guid.NewGuid(), allocation = Guid.NewGuid(), statement = Guid.NewGuid(), income = Guid.NewGuid();
            await db.Database.ExecuteSqlRawAsync(
                """
                INSERT INTO [Accounts] ([Id], [OwnerId], [Name], [Type], [Currency], [OpeningBalance], [DisplayOrder])
                VALUES ({0}, {2}, N'A', 0, N'EUR', 0, 0), ({1}, {2}, N'B', 0, N'EUR', 0, 1);
                INSERT INTO [Transactions] ([Id], [OwnerId], [Amount], [Type], [Date], [Payee], [AccountId], [TransferAccountId], [DepartedOn], [BankReference])
                VALUES ({3}, {2}, 10, 2, '2026-09-10', N'Allocation', {0}, {1}, '2026-09-10', N'alloc:2026-09:member'),
                       ({4}, {2}, 10, 2, '2026-09-10', N'Transfer', {0}, {1}, '2026-09-10', N'STATEMENT-1'),
                       ({5}, {2}, 10, 0, '2026-09-10', N'Refund', {0}, NULL, NULL, N'alloc:looks-like-a-key');
                """,
                a, b, owner, allocation, statement, income);

            await migrator.MigrateAsync(w07);
            var rows = await db.Transactions.IgnoreQueryFilters().AsNoTracking()
                .Where(t => t.OwnerId == owner)
                .ToDictionaryAsync(t => t.Id, t => new { t.BankReference, t.AllocationKey });
            rows[allocation].Should().Be(new { BankReference = (string?)null, AllocationKey = (string?)"alloc:2026-09:member" });
            rows[statement].Should().Be(new { BankReference = (string?)"STATEMENT-1", AllocationKey = (string?)null });
            rows[income].Should().Be(new { BankReference = (string?)"alloc:looks-like-a-key", AllocationKey = (string?)null },
                "only transfers carried the allocation key");

            await migrator.MigrateAsync(before);
            var restored = await db.Database
                .SqlQueryRaw<string>("SELECT [BankReference] AS [Value] FROM [Transactions] WHERE [Id] = {0}", allocation)
                .SingleAsync();
            restored.Should().Be("alloc:2026-09:member");
        }
        finally
        {
            await db.Database.EnsureDeletedAsync();
        }
    }
}
