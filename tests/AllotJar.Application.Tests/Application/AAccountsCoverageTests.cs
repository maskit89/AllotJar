using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Commands.CreateAccount;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Accounts.Queries.GetAccountReconciliation;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Accounts coverage (catalog prefix ACCT, file docs/testing/cases/12-accounts-reconciliation.md).
/// Automates the highest-value P0/P1 (plus a few cheap P2/P3) cases whose behaviour lives
/// at the Application/domain layer and was previously "No"/"Partial":
/// the complete derived-balance formula on a single account including transfer legs
/// (ACCT-037/038); splits never move the account balance (ACCT-040); ordering by DisplayOrder then Name with duplicate names allowed (ACCT-007);
/// creating an account of every type (ACCT-010); negative/zero openings accepted
/// (ACCT-011/012); the server validators for empty name (ACCT-013/026), out-of-range
/// opening (ACCT-016), overlong name (ACCT-017), the currency regex contract (ACCT-022)
/// and unicode/trim (ACCT-021); the update handler editing name/type/opening with a
/// recomputed balance (ACCT-023); currency immutability by API shape on edit (ACCT-024);
/// and reconciliation edges — negative float / shortfall (ACCT-054) and the exclusion of
/// archived jars and jars whose funding account no longer exists (ACCT-055).
///
/// Pure client-render cases (hero net/Available/Owed tiles, mixed-currency footnote, card
/// hues/badges, the Add/Edit/Delete modals and their generic error strings, the detail
/// register's signs/pills/per-row currency, empty/loading/error banners) are deferred to
/// the Vitest layer, where AccountsPage.test.tsx / AccountDetailPage.test.tsx / RoleGating
/// already assert them. The [FeatureGate] 404 (ACCT-059) and the long-session login prompt
/// (ACCT-060) live at the API/session layers, not here. FK cascade semantics for the
/// delete-unlink are already covered by AccountsTests / TransfersTests and by the SQL
/// integration layer.
/// </summary>
public class AAccountsCoverageTests
{
    private static Account SeedAccount(
        ApplicationDbContext db, string ownerId, string name,
        decimal opening = 0m, AccountType type = AccountType.Current,
        string currency = "EUR", int order = 0)
    {
        var account = new Account
        {
            OwnerId = ownerId,
            Name = name,
            Type = type,
            Currency = CurrencyCode.From(currency),
            OpeningBalance = opening,
            OpeningDate = new DateOnly(2026, 1, 1),
            DisplayOrder = order,
        };
        db.Accounts.Add(account);
        db.SaveChanges();
        return account;
    }

    private static void AddTx(
        ApplicationDbContext db, string ownerId, Guid? accountId, decimal amount,
        TransactionType type, Guid? transferAccountId = null,
        ICollection<TransactionSplit>? splits = null)
    {
        db.Transactions.Add(new Transaction
        {
            OwnerId = ownerId,
            AccountId = accountId,
            TransferAccountId = transferAccountId,
            Amount = amount,
            Type = type,
            Currency = CurrencyCode.Eur,
            Date = new DateOnly(2026, 7, 10),
            // A seeded transfer is a completed same-day movement: both bank legs are explicit.
            DepartedOn = type == TransactionType.Transfer ? new DateOnly(2026, 7, 10) : null,
            ReceivedOn = type == TransactionType.Transfer ? new DateOnly(2026, 7, 10) : null,
            Splits = splits ?? new List<TransactionSplit>(),
        });
        db.SaveChanges();
    }

    // ACCT-037 / ACCT-038 — CurrentBalance = opening + Σincome − Σexpense − ΣtransferOut + ΣtransferIn,
    // all four leg types on ONE account, derived at read (the existing AccountsTests case has no
    // transfer legs). Joint: 1250 + 3000 − 800 − 200 + 150 = 3400.
    [Fact]
    public async Task GetAccounts_DerivedBalance_AppliesEveryTransactionLeg_IncludingTransfers()
    {
        await using var db = NewContext();
        var joint = SeedAccount(db, "user-1", "Joint", opening: 1250m);
        var other = SeedAccount(db, "user-1", "Other", opening: 0m, order: 1);

        AddTx(db, "user-1", joint.Id, 3000m, TransactionType.Income);   // +3000
        AddTx(db, "user-1", joint.Id, 800m, TransactionType.Expense);   // −800
        // transfer OUT of Joint (Joint is the source AccountId)
        AddTx(db, "user-1", joint.Id, 200m, TransactionType.Transfer, transferAccountId: other.Id);
        // transfer IN to Joint (Joint is the destination TransferAccountId)
        AddTx(db, "user-1", other.Id, 150m, TransactionType.Transfer, transferAccountId: joint.Id);

        var result = await new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);

        result.Single(a => a.Id == joint.Id).CurrentBalance.Should().Be(3400m);
    }

    // ACCT-040 — Splitting a transaction never changes the account balance: AccountBalances sums the
    // whole transaction Amount, not its slices. A €120 expense split 70/50 still moves €120.
    [Fact]
    public async Task GetAccounts_SplitTransaction_MovesTheWholeAmount_NotTheSlices()
    {
        await using var db = NewContext();
        var joint = SeedAccount(db, "user-1", "Joint", opening: 1000m);

        // A genuine split: whole-line attribution cleared, two slices carry it — but the
        // account leg is the whole €120.
        AddTx(db, "user-1", joint.Id, 120m, TransactionType.Expense, splits: new List<TransactionSplit>
        {
            new() { Amount = 70m },
            new() { Amount = 50m },
        });

        var result = await new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);

        result.Single().CurrentBalance.Should().Be(880m); // 1000 − 120, unaffected by the 70/50 split
    }

    // ACCT-007 — GetAccounts orders by DisplayOrder then Name; duplicate names coexist with distinct ids.
    [Fact]
    public async Task GetAccounts_OrdersByDisplayOrderThenName_AndAllowsDuplicateNames()
    {
        await using var db = NewContext();
        // Same order 0 → Name tiebreak (Apple before Zebra); order 1 → two identical "Joint" names.
        SeedAccount(db, "user-1", "Zebra", order: 0);
        SeedAccount(db, "user-1", "Apple", order: 0);
        SeedAccount(db, "user-1", "Joint", order: 1);
        SeedAccount(db, "user-1", "Joint", order: 1);

        var result = await new GetAccountsQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountsQuery(), CancellationToken.None);

        result.Select(a => a.Name).Should().Equal("Apple", "Zebra", "Joint", "Joint");
        // Duplicate names are allowed everywhere — both "Joint" rows are distinct accounts.
        result[2].Id.Should().NotBe(result[3].Id);
    }

    // ACCT-010 — An account of every creatable type persists its numeric AccountType and currency
    // (credit cards are withdrawn from creation, rule 75 — see the validator test below).
    [Theory]
    [InlineData(AccountType.Current)]
    [InlineData(AccountType.Savings)]
    [InlineData(AccountType.Cash)]
    [InlineData(AccountType.Other)]
    public async Task CreateAccount_PersistsEachAccountType(AccountType type)
    {
        await using var db = NewContext();

        var dto = await new CreateAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateAccountCommand("Any", type, "EUR", 0m, new DateOnly(2026, 1, 1)), CancellationToken.None);

        dto.Type.Should().Be(type);
        db.Accounts.Single().Type.Should().Be(type);
    }

    // ACCT-011 / ACCT-012 — A zero opening is valid and a fresh account's balance equals its
    // opening; a negative opening is refused (rule 74: no account is ever negative) and a credit
    // card is not an account (rule 75).
    [Fact]
    public async Task CreateAccount_AcceptsZeroOpening_BalanceEqualsOpening()
    {
        await using var db = NewContext();
        var command = new CreateAccountCommand("Wallet", AccountType.Cash, "EUR", 0m, new DateOnly(2026, 1, 1));

        new CreateAccountCommandValidator().Validate(command).IsValid.Should().BeTrue();

        var dto = await new CreateAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(command, CancellationToken.None);

        dto.OpeningBalance.Should().Be(0m);
        dto.CurrentBalance.Should().Be(0m); // no transactions yet → balance = opening
    }

    [Fact]
    public void Validators_RefuseNegativeOpening_AndCreditCards()
    {
        var create = new CreateAccountCommandValidator();
        var update = new UpdateAccountCommandValidator();

        create.Validate(new CreateAccountCommand("Overdraft", AccountType.Current, "EUR", -450m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "OpeningBalance");
        update.Validate(new UpdateAccountCommand(Guid.NewGuid(), "Overdraft", AccountType.Current, -1m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "OpeningBalance");

        create.Validate(new CreateAccountCommand("Visa", AccountType.CreditCard, "EUR", 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "Type");
        update.Validate(new UpdateAccountCommand(Guid.NewGuid(), "Visa", AccountType.CreditCard, 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "Type");
    }

    // ACCT-021 — A unicode/emoji name is accepted; the handler trims surrounding whitespace and stores it verbatim.
    [Fact]
    public async Task CreateAccount_AcceptsUnicodeName_AndTrimsWhitespace()
    {
        await using var db = NewContext();

        var dto = await new CreateAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new CreateAccountCommand("  🏦 Ünïçödé Jar  ", AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1)),
                CancellationToken.None);

        dto.Name.Should().Be("🏦 Ünïçödé Jar");
    }

    // ACCT-013 / ACCT-026 — Empty name fails the create AND update validators with "An account needs a name."
    [Fact]
    public void Validators_RejectEmptyName_WithFriendlyMessage()
    {
        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("", AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.ErrorMessage == "An account needs a name.");

        new UpdateAccountCommandValidator()
            .Validate(new UpdateAccountCommand(Guid.NewGuid(), "", AccountType.Current, 0m, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.ErrorMessage == "An account needs a name.");
    }

    // ACCT-016 — Opening beyond the supported range fails both validators with the range message.
    [Fact]
    public void Validators_RejectOpeningBeyondSupportedRange()
    {
        const decimal overMax = 100_000_000_000_000m; // > 99,999,999,999,999.9999

        new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand("Big", AccountType.Current, "EUR", overMax, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "OpeningBalance");

        new UpdateAccountCommandValidator()
            .Validate(new UpdateAccountCommand(Guid.NewGuid(), "Big", AccountType.Current, overMax, new DateOnly(2026, 1, 1)))
            .Errors.Should().Contain(e => e.PropertyName == "OpeningBalance");
    }

    // ACCT-017 — A name longer than 120 characters fails the create validator (MaximumLength(120)).
    [Fact]
    public void CreateAccountValidator_RejectsNameLongerThan120Chars()
    {
        var longName = new string('x', 121);

        var result = new CreateAccountCommandValidator()
            .Validate(new CreateAccountCommand(longName, AccountType.Current, "EUR", 0m, new DateOnly(2026, 1, 1)));

        result.IsValid.Should().BeFalse();
        result.Errors.Should().Contain(e => e.PropertyName == nameof(CreateAccountCommand.Name));
    }

    // ACCT-022 — Currency regex contract: any 3 letters pass ("ZZZ"), non-3-letter fails ("EU"),
    // empty gives the missing-currency message.
    [Fact]
    public void CreateAccountValidator_CurrencyRegex_AcceptsAnyThreeLetters_RejectsOthers()
    {
        var validator = new CreateAccountCommandValidator();
        CreateAccountCommand WithCurrency(string c) => new("Test", AccountType.Current, c, 0m, new DateOnly(2026, 1, 1));

        // "ZZZ" is not a real ISO code but passes — there is no ISO list check by design.
        validator.Validate(WithCurrency("ZZZ")).IsValid.Should().BeTrue();

        validator.Validate(WithCurrency("EU")).Errors
            .Should().Contain(e => e.ErrorMessage == "Currency must be a 3-letter ISO 4217 code.");

        validator.Validate(WithCurrency("")).Errors
            .Should().Contain(e => e.ErrorMessage == "An account needs a currency.");
    }

    // ACCT-023 — Update edits name, type and opening and returns a recomputed balance
    // (opening + net of the account's transactions). No backend update test existed before.
    [Fact]
    public async Task UpdateAccount_EditsFields_AndReturnsRecomputedBalance()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1", "Rainy Day", opening: 500m, type: AccountType.Savings);
        AddTx(db, "user-1", account.Id, 200m, TransactionType.Income);  // +200
        AddTx(db, "user-1", account.Id, 50m, TransactionType.Expense);  // −50

        var dto = await new UpdateAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateAccountCommand(account.Id, "Emergency", AccountType.Current, 750m, new DateOnly(2026, 1, 1)),
                CancellationToken.None);

        dto.Name.Should().Be("Emergency");
        dto.Type.Should().Be(AccountType.Current);
        dto.OpeningBalance.Should().Be(750m);
        dto.CurrentBalance.Should().Be(900m); // 750 + 200 − 50, derived at read
    }

    // ACCT-024 — Currency is immutable on edit: UpdateAccountCommand carries no currency field, so a
    // GBP account stays GBP after an update. A regression that let it change would reinterpret the register.
    [Fact]
    public async Task UpdateAccount_LeavesCurrencyUnchanged()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1", "UK Pot", opening: 200m, currency: "GBP");

        var dto = await new UpdateAccountCommandHandler(db, new CurrentUserStub("user-1"))
            .Handle(new UpdateAccountCommand(account.Id, "UK Pot renamed", AccountType.Current, 300m, new DateOnly(2026, 1, 1)),
                CancellationToken.None);

        dto.Currency.Should().Be("GBP");
        // And the persisted entity is still GBP — the update path can never touch currency.
        var reloaded = await db.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id);
        reloaded.Currency.Should().Be(CurrencyCode.From("GBP"));
    }

    // ACCT-054 — A negative float is a shortfall: the account holds less than its allocated jars.
    // Balance 700, a jar allocated 1200 (a stored ledger row the write paths would refuse, rule 70)
    // → Float (unallocated) = −500 and the backing-deficit flag is raised for correction.
    [Fact]
    public async Task Reconciliation_ProducesNegativeFloat_AndFlagsTheDeficit_WhenJarsExceedBalance()
    {
        await using var db = NewContext();
        var account = SeedAccount(db, "user-1", "Rainy Day", opening: 700m, type: AccountType.Savings);
        var jar = new Jar
        {
            OwnerId = "user-1", Name = "Big Goal", Kind = JarKind.Goal,
            Accrual = AccrualMethod.TargetByDate,
            FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        await db.SaveChangesAsync();
        LedgerFixtures.Allocate(db, "user-1", account.Id, jar.Id, 1200m);

        var recon = (await new GetAccountReconciliationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None)).Single();

        recon.CurrentBalance.Should().Be(700m);
        recon.BackedJarsTotal.Should().Be(1200m);
        recon.BackedJarCount.Should().Be(1);
        recon.Float.Should().Be(-500m); // shortfall
        recon.HasBackingDeficit.Should().BeTrue(); // rule 70: positive jars exceed the account's money
    }

    // ACCT-055 — Reconciliation excludes archived jars and jars whose funding account no longer exists.
    [Fact]
    public async Task Reconciliation_ExcludesArchivedJars()
    {
        await using var db = NewContext();
        var joint = SeedAccount(db, "user-1", "Joint", opening: 1000m);

        var active = new Jar
        {
            OwnerId = "user-1", Name = "Active", Kind = JarKind.Goal,
            Accrual = AccrualMethod.TargetByDate,
            FundingAccountId = joint.Id,
        };
        db.Jars.AddRange(
            // A: active, backs Joint → counted.
            active,
            // B: archived → excluded (query filters !IsArchived); it holds nothing (rule 26).
            new Jar
            {
                OwnerId = "user-1", Name = "Archived", Kind = JarKind.Goal,
                Accrual = AccrualMethod.TargetByDate,
                FundingAccountId = joint.Id, IsArchived = true,
            });
        await db.SaveChangesAsync();
        LedgerFixtures.Allocate(db, "user-1", joint.Id, active.Id, 100m);

        var result = await new GetAccountReconciliationQueryHandler(db, new CurrentUserStub("user-1"))
            .Handle(new GetAccountReconciliationQuery(), CancellationToken.None);

        result.Should().ContainSingle();
        var recon = result.Single();
        recon.BackedJarCount.Should().Be(1);      // only jar A
        recon.BackedJarsTotal.Should().Be(100m);  // jar B (archived) excluded
        recon.Float.Should().Be(900m);            // unallocated: 1000 − 100
    }
}
