using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// Guards the import-dedup backstop on real SQL Server. The commit handler's duplicate check is
/// per-request memory, so two OVERLAPPING commits (double-click, two devices, two logins in one
/// household) would both pass it — only the unique filtered (OwnerId, AccountId, BankReference)
/// index stops the second insert, and the handler must then recover by skipping the collided rows.
/// The account scope also lets a reference a bank reuses across accounts through as distinct. The
/// EF in-memory provider can't validate either half of that contract.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class UniqueBankReferenceTests
{
    private readonly SqlServerFixture _fixture;

    public UniqueBankReferenceTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class CurrentUserStub(string? userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
    }

    /// <summary>Returns rate 1 and, on its FIRST call, runs a callback — used to deterministically
    /// inject a competing insert into the window between the handler's dedup snapshot and its save.</summary>
    private sealed class TrapRateProvider(Func<Task>? onFirstCall = null) : IExchangeRateProvider
    {
        private bool _fired;

        public async Task<decimal?> GetRateAsync(
            CurrencyCode from, CurrencyCode to, DateOnly date, CancellationToken cancellationToken)
        {
            if (!_fired && onFirstCall is not null)
            {
                _fired = true;
                await onFirstCall();
            }
            return 1m;
        }
    }

    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private static Transaction ImportedRow(
        string ownerId, string? reference, decimal amount = 10m, string currency = "EUR", Guid? accountId = null) => new()
    {
        OwnerId = ownerId,
        Amount = amount,
        Currency = CurrencyCode.From(currency),
        ExchangeRate = 1m,
        Type = TransactionType.Expense,
        Date = new DateOnly(2026, 6, 15),
        Payee = "GROCER",
        BankReference = reference,
        AccountId = accountId,
    };

    private static async Task<Account> SeedAccountAsync(ApplicationDbContext db, string ownerId, string name)
    {
        var account = new Account { OwnerId = ownerId, Name = name, Currency = CurrencyCode.Eur };
        db.Accounts.Add(account);
        await db.SaveChangesAsync();
        return account;
    }

    private static CommitImportItem Item(string reference, decimal amount = 10m, string currency = "EUR") =>
        new(reference, new DateOnly(2026, 6, 15), "GROCER", amount, currency,
            IsCredit: false, BudgetItemId: null, MemberId: null);

    [Fact]
    public async Task Database_refuses_a_duplicate_owner_reference_pair()
    {
        var owner = NewOwner();
        await using (var db = _fixture.CreateContext())
        {
            db.Transactions.Add(ImportedRow(owner, "ref-dup"));
            await db.SaveChangesAsync();
        }

        await using var second = _fixture.CreateContext();
        second.Transactions.Add(ImportedRow(owner, "ref-dup"));
        var act = () => second.SaveChangesAsync();

        // The unique filtered index is the backstop the in-memory suite can't see.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Same_reference_under_different_owners_is_allowed()
    {
        var ownerA = NewOwner();
        var ownerB = NewOwner();
        await using var db = _fixture.CreateContext();
        db.Transactions.Add(ImportedRow(ownerA, "ref-shared"));
        db.Transactions.Add(ImportedRow(ownerB, "ref-shared"));

        await db.SaveChangesAsync(); // scoped per household — must not collide

        (await db.Transactions.CountAsync(t => t.BankReference == "ref-shared")).Should().Be(2);
    }

    [Fact]
    public async Task Same_reference_on_different_accounts_is_allowed()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var accountA = await SeedAccountAsync(db, owner, "A");
        var accountB = await SeedAccountAsync(db, owner, "B");

        // Banks legitimately reuse a reference across accounts (standing orders, pooled refs),
        // and CSV imports synthesise a content hash — so the same reference on two DIFFERENT
        // accounts is a genuinely distinct transaction, not a duplicate (F7).
        db.Transactions.Add(ImportedRow(owner, "reused-ref", accountId: accountA.Id));
        db.Transactions.Add(ImportedRow(owner, "reused-ref", accountId: accountB.Id));

        await db.SaveChangesAsync(); // account-scoped index must not collide these

        (await db.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "reused-ref"))
            .Should().Be(2);
    }

    [Fact]
    public async Task Duplicate_reference_on_the_same_account_still_collides()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner, "A");

        db.Transactions.Add(ImportedRow(owner, "same-acct-ref", accountId: account.Id));
        await db.SaveChangesAsync();

        await using var second = _fixture.CreateContext();
        second.Transactions.Add(ImportedRow(owner, "same-acct-ref", accountId: account.Id));
        Func<Task> act = () => second.SaveChangesAsync();

        // Re-importing the same reference onto the SAME account is still a duplicate.
        await act.Should().ThrowAsync<DbUpdateException>();
    }

    [Fact]
    public async Task Reference_less_manual_transactions_are_exempt_from_the_index()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        db.Transactions.Add(ImportedRow(owner, reference: null));
        db.Transactions.Add(ImportedRow(owner, reference: null));

        // Two null references for the same owner: the filter must exempt them.
        var act = () => db.SaveChangesAsync();
        await act.Should().NotThrowAsync();
    }

    [Fact]
    public async Task Commit_recovers_when_a_concurrent_commit_wins_the_race()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();

        // Foreign-currency rows force a rate lookup, which happens AFTER the handler's dedup
        // snapshot and BEFORE its save — the trap inserts the competing row exactly there,
        // deterministically reproducing the double-click / second-device race.
        var trap = new TrapRateProvider(async () =>
        {
            await using var rival = _fixture.CreateContext();
            rival.Transactions.Add(ImportedRow(owner, "race-1", currency: "USD"));
            await rival.SaveChangesAsync();
        });

        var handler = new CommitImportCommandHandler(db, new CurrentUserStub(owner), trap);
        var result = await handler.Handle(
            new CommitImportCommand(null, new[] { Item("race-1", currency: "USD"), Item("race-2", currency: "USD") }),
            CancellationToken.None);

        // The collided row is skipped, the rest still lands — and the DB holds exactly one of each.
        result.Imported.Should().Be(1);
        result.SkippedDuplicates.Should().Be(1);

        await using var verify = _fixture.CreateContext();
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "race-1"))
            .Should().Be(1);
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "race-2"))
            .Should().Be(1);
    }

    [Fact]
    public async Task Sequential_resubmit_still_skips_everything_without_touching_the_recovery_path()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var items = new[] { Item("seq-1"), Item("seq-2") };

        var first = await new CommitImportCommandHandler(db, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(null, items), CancellationToken.None);

        await using var db2 = _fixture.CreateContext();
        var second = await new CommitImportCommandHandler(db2, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(null, items), CancellationToken.None);

        first.Imported.Should().Be(2);
        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(2);
    }

    // --- Transfer-direction dedup (2026-07-22 re-review F6): a row from account A's statement
    // marked as an INBOUND transfer is stored with the counterparty as its source
    // (AccountId = B, TransferAccountId = A) — the dedup snapshot and the collision recovery
    // must both account for that, or re-importing A's statement crashes. --------------------

    private static CommitImportItem TransferItem(string reference, Guid counterpartyId, bool isCredit) =>
        new(reference, new DateOnly(2026, 6, 15), "TOP-UP", 100m, "EUR",
            IsCredit: isCredit, BudgetItemId: null, MemberId: null,
            Splits: null, TransferAccountId: counterpartyId);

    [Fact]
    public async Task Reimporting_a_statement_with_an_inbound_transfer_skips_it()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var accountA = await SeedAccountAsync(db, owner, "A"); // the statement account
        var accountB = await SeedAccountAsync(db, owner, "B"); // the counterparty

        // A credit into A from B: the saved row's AccountId is B (the source).
        var first = await new CommitImportCommandHandler(db, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(accountA.Id, new[]
            {
                TransferItem("in-ref", accountB.Id, isCredit: true),
            }), CancellationToken.None);
        first.Imported.Should().Be(1);

        // Re-import the same statement into A. The old account-scoped snapshot queried
        // AccountId == A, missed the row (stored on B), re-inserted, collided on (owner, B, ref),
        // and the recovery — also searching A — rethrew: the whole re-import 500ed.
        await using var db2 = _fixture.CreateContext();
        var second = await new CommitImportCommandHandler(db2, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(accountA.Id, new[]
            {
                TransferItem("in-ref", accountB.Id, isCredit: true),
            }), CancellationToken.None);

        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(1);
        await using var verify = _fixture.CreateContext();
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "in-ref"))
            .Should().Be(1);
    }

    [Fact]
    public async Task Reimporting_a_statement_with_an_outbound_transfer_skips_it()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var accountA = await SeedAccountAsync(db, owner, "A");
        var accountB = await SeedAccountAsync(db, owner, "B");

        // A debit out of A to B: the saved row's AccountId is A — the straightforward case,
        // guarded so the inbound fix can't regress it.
        await new CommitImportCommandHandler(db, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(accountA.Id, new[]
            {
                TransferItem("out-ref", accountB.Id, isCredit: false),
            }), CancellationToken.None);

        await using var db2 = _fixture.CreateContext();
        var second = await new CommitImportCommandHandler(db2, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(accountA.Id, new[]
            {
                TransferItem("out-ref", accountB.Id, isCredit: false),
            }), CancellationToken.None);

        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task Case_variant_reference_is_skipped_on_reimport()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        var account = await SeedAccountAsync(db, owner, "A");

        await new CommitImportCommandHandler(db, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(account.Id, new[] { Item("Ref-Case") }), CancellationToken.None);

        // The database index compares with the CI collation, so the case-variant WOULD collide —
        // the snapshot must skip it up front rather than fall into recovery.
        await using var db2 = _fixture.CreateContext();
        var second = await new CommitImportCommandHandler(db2, new CurrentUserStub(owner), new TrapRateProvider())
            .Handle(new CommitImportCommand(account.Id, new[] { Item("REF-CASE") }), CancellationToken.None);

        second.Imported.Should().Be(0);
        second.SkippedDuplicates.Should().Be(1);
    }

    [Fact]
    public async Task Commit_recovers_when_a_concurrent_commit_wins_the_race_on_an_inbound_transfer()
    {
        var owner = NewOwner();
        await using var db = _fixture.CreateContext();
        // USD accounts + USD rows: foreign against the (EUR-default) budget base, so BOTH rows
        // trigger a rate lookup — the trap's window between the dedup snapshot and the save —
        // while still matching the account currency the import invariant enforces.
        var accountA = new Account { OwnerId = owner, Name = "A", Currency = CurrencyCode.From("USD") };
        var accountB = new Account { OwnerId = owner, Name = "B", Currency = CurrencyCode.From("USD") };
        db.Accounts.AddRange(accountA, accountB);
        await db.SaveChangesAsync();

        // The rival inserts the SAME inbound-transfer row inside the trap window (stored with the
        // counterparty B as its source), so our save collides on (owner, B, ref).
        var trap = new TrapRateProvider(async () =>
        {
            await using var rival = _fixture.CreateContext();
            rival.Transactions.Add(new Transaction
            {
                OwnerId = owner, Amount = 100m, Currency = CurrencyCode.From("USD"), ExchangeRate = 1m,
                Type = TransactionType.Transfer, Date = new DateOnly(2026, 6, 15), Payee = "TOP-UP",
                BankReference = "race-in", AccountId = accountB.Id, TransferAccountId = accountA.Id,
            });
            await rival.SaveChangesAsync();
        });

        var result = await new CommitImportCommandHandler(db, new CurrentUserStub(owner), trap)
            .Handle(new CommitImportCommand(accountA.Id, new[]
            {
                new CommitImportItem("race-in", new DateOnly(2026, 6, 15), "TOP-UP", 100m, "USD",
                    IsCredit: true, BudgetItemId: null, MemberId: null,
                    Splits: null, TransferAccountId: accountB.Id),
                Item("race-plain", currency: "USD"),
            }), CancellationToken.None);

        // The old recovery searched the STATEMENT account (A), found nothing for the transfer
        // (stored on B), and rethrew. It must skip the collided transfer and keep the plain row.
        result.Imported.Should().Be(1);
        result.SkippedDuplicates.Should().Be(1);
        await using var verify = _fixture.CreateContext();
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "race-in"))
            .Should().Be(1);
        (await verify.Transactions.CountAsync(t => t.OwnerId == owner && t.BankReference == "race-plain"))
            .Should().Be(1);
    }
}
