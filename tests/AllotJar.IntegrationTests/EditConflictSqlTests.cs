using System.Text.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using AllotJar.Api.Middleware;
using AllotJar.Application.Accounts.Commands.UpdateAccount;
using AllotJar.Application.Allocation.Commands.UpsertAllocationProfile;
using AllotJar.Application.Budgets.Commands.RenameBudgetCategory;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Common;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Household.Commands.UpdateHouseholdMember;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.ConfirmTransferLegs;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Common;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;

namespace AllotJar.IntegrationTests;

/// <summary>
/// D11 on SQL Server (EF InMemory keeps no row versions): two logins load the same record, the
/// first save wins, and the second, sent with the version it loaded, is refused with a 409
/// instead of silently overwriting the first. A save carrying the current version goes through.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class EditConflictSqlTests(SqlServerFixture fixture)
{
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Jan1 = new(2026, 1, 1);
    private static string NewOwner() => $"user-{Guid.NewGuid():N}";

    private async Task<T> SeedAsync<T>(T entity) where T : class
    {
        await using var db = fixture.CreateContext();
        db.Add(entity);
        await db.SaveChangesAsync(Ct);
        return entity;
    }

    private Task<Account> SeedAccountAsync(string owner, string name, decimal opening = 1000m) => SeedAsync(new Account
    {
        OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
        OpeningBalance = opening, OpeningDate = Jan1,
    });

    /// <summary>What an edit form loads: the record's current version, as its DTO carries it.</summary>
    private async Task<string> LoadVersionAsync<T>(Guid id) where T : BaseEntity, IVersioned
    {
        await using var db = fixture.CreateContext();
        var version = EditVersions.Of(await db.Set<T>().AsNoTracking().SingleAsync(e => e.Id == id, Ct));
        version.Should().NotBeNull("SQL Server stamps every row with a version");
        return version!;
    }

    private async Task<Exception?> SaveAsync(Func<Infrastructure.Persistence.ApplicationDbContext, Task> save)
    {
        await using var db = fixture.CreateContext();
        try
        {
            await save(db);
            return null;
        }
        catch (Exception ex)
        {
            return ex;
        }
    }

    /// <summary>What the API answers for <paramref name="thrown"/>: status and title.</summary>
    private static async Task<(int Status, string Title)> AnswerAsync(Exception thrown)
    {
        var context = new DefaultHttpContext { Response = { Body = new MemoryStream() } };
        var middleware = new ExceptionHandlingMiddleware(_ => throw thrown, NullLogger<ExceptionHandlingMiddleware>.Instance);
        await middleware.InvokeAsync(context);
        context.Response.Body.Position = 0;
        using var body = await JsonDocument.ParseAsync(context.Response.Body);
        return (context.Response.StatusCode, body.RootElement.GetProperty("title").GetString()!);
    }

    [Fact]
    public async Task A_transaction_saved_from_a_stale_load_is_refused_and_changes_nothing()
    {
        var owner = NewOwner();
        var account = await SeedAccountAsync(owner, "Everyday");
        var expense = await SeedAsync(new Transaction
        {
            OwnerId = owner, Date = new DateOnly(2026, 9, 3), Payee = "Grocer", Amount = 40m, Currency = CurrencyCode.Eur,
            Type = TransactionType.Expense, AccountId = account.Id,
        });

        // Two logins open the same transaction: both forms hold the version the read returned.
        string first, second;
        await using (var read = fixture.CreateContext())
        {
            first = (await TransactionReads.ReadDtoAsync(read, expense.Id, Ct)).Version!;
        }
        await using (var read = fixture.CreateContext())
        {
            second = (await TransactionReads.ReadDtoAsync(read, expense.Id, Ct)).Version!;
        }
        first.Should().NotBeNullOrEmpty().And.Be(second);

        string? current = null;
        (await SaveAsync(async db => current = (await new UpdateTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransactionCommand(expense.Id, expense.Date, "Grocer (Sam)", 40m, TransactionType.Expense, account.Id,
                Version: first), Ct)).Version)).Should().BeNull();

        var stale = await SaveAsync(db => new UpdateTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransactionCommand(expense.Id, expense.Date, "Grocer (Alex)", 55m, TransactionType.Expense, account.Id,
                Version: second), Ct));

        stale.Should().BeOfType<EditConflictException>();
        (await AnswerAsync(stale!)).Should().Be((StatusCodes.Status409Conflict, "Someone else changed this. Reload and try again."));
        await using (var verify = fixture.CreateContext())
        {
            var row = await verify.Transactions.AsNoTracking().SingleAsync(t => t.Id == expense.Id, Ct);
            row.Payee.Should().Be("Grocer (Sam)");
            row.Amount.Should().Be(40m);
        }

        // Reloaded, the second login's form carries the current version and its save goes through.
        current.Should().NotBe(first);
        (await SaveAsync(db => new UpdateTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransactionCommand(expense.Id, expense.Date, "Grocer (Alex)", 55m, TransactionType.Expense, account.Id,
                Version: current), Ct))).Should().BeNull();
        await using var after = fixture.CreateContext();
        (await after.Transactions.AsNoTracking().SingleAsync(t => t.Id == expense.Id, Ct)).Amount.Should().Be(55m);
    }

    [Fact]
    public async Task A_transfer_edit_of_one_leg_refuses_a_stale_edit_of_the_other()
    {
        var owner = NewOwner();
        var from = await SeedAccountAsync(owner, "Everyday");
        var to = await SeedAccountAsync(owner, "Savings", 0m);
        Guid transferId;
        await using (var seed = fixture.CreateContext())
        {
            transferId = (await new CreateTransferCommandHandler(seed, new CurrentUserStub(owner)).Handle(
                new CreateTransferCommand(new DateOnly(2026, 1, 15), 100m, from.Id, to.Id), Ct)).Id;
        }
        var loaded = await LoadVersionAsync<Transaction>(transferId);

        // One login confirms the receipt leg's date ...
        (await SaveAsync(db => new UpdateTransferCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransferCommand(transferId, from.Id, to.Id, 100m, new DateOnly(2026, 1, 15), new DateOnly(2026, 1, 16),
                Version: loaded), Ct))).Should().BeNull();

        // ... so the other's edit of the departure leg, from the same load, would wipe it: refused.
        var stale = await SaveAsync(db => new UpdateTransferCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransferCommand(transferId, from.Id, to.Id, 120m, new DateOnly(2026, 1, 14), null, Version: loaded), Ct));

        stale.Should().BeOfType<EditConflictException>();
        await using (var verify = fixture.CreateContext())
        {
            var row = await verify.Transactions.AsNoTracking().SingleAsync(t => t.Id == transferId, Ct);
            row.Amount.Should().Be(100m);
            row.DepartedOn.Should().Be(new DateOnly(2026, 1, 15));
            row.ReceivedOn.Should().Be(new DateOnly(2026, 1, 16));
        }

        var current = await LoadVersionAsync<Transaction>(transferId);
        (await SaveAsync(db => new UpdateTransferCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateTransferCommand(transferId, from.Id, to.Id, 120m, new DateOnly(2026, 1, 14), new DateOnly(2026, 1, 16),
                Version: current), Ct))).Should().BeNull();
    }

    /// <summary>A purchase with no line yet, and three September lines to split it across.</summary>
    private async Task<(string Owner, Account Account, Transaction Purchase, BudgetItem Food, BudgetItem Home, BudgetItem Fun)> SeedPurchaseAsync()
    {
        var owner = NewOwner();
        var account = await SeedAccountAsync(owner, "Everyday");
        var food = new BudgetItem { Name = "Food", PlannedAmount = 300m, DisplayOrder = 0 };
        var home = new BudgetItem { Name = "Home", PlannedAmount = 100m, DisplayOrder = 1 };
        var fun = new BudgetItem { Name = "Fun", PlannedAmount = 50m, DisplayOrder = 2 };
        await SeedAsync(new BudgetMonth
        {
            OwnerId = owner, Year = 2026, Month = 9, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Living", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { food, home, fun } },
            },
        });
        var purchase = await SeedAsync(new Transaction
        {
            OwnerId = owner, Date = new DateOnly(2026, 9, 3), Payee = "Supermarket", Amount = 40m, Currency = CurrencyCode.Eur,
            Type = TransactionType.Expense, AccountId = account.Id,
        });
        return (owner, account, purchase, food, home, fun);
    }

    private static Task<TransactionDto> SplitAsync(
        Infrastructure.Persistence.ApplicationDbContext db, string owner, Guid transactionId, string? version,
        params (BudgetItem Line, decimal Amount)[] slices) =>
        new SplitTransactionCommandHandler(db, new CurrentUserStub(owner)).Handle(new SplitTransactionCommand(
            transactionId, slices.Select(x => new SplitAllocationInput(x.Line.Id, x.Amount)).ToList(), Version: version), Ct);

    private async Task<List<(Guid?, decimal)>> SlicesAsync(Guid transactionId)
    {
        await using var db = fixture.CreateContext();
        return (await db.TransactionSplits.AsNoTracking().Where(x => x.TransactionId == transactionId).ToListAsync(Ct))
            .Select(x => (x.BudgetItemId, x.Amount)).ToList();
    }

    [Fact]
    public async Task A_split_saved_from_a_stale_load_is_refused_and_keeps_the_other_logins_split()
    {
        // #308 review P2-1: the split editor loads the slices and saves them back whole.
        var s = await SeedPurchaseAsync();
        var loaded = await LoadVersionAsync<Transaction>(s.Purchase.Id);

        // Sam splits the purchase Food 30 / Home 10 ...
        (await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, loaded, (s.Food, 30m), (s.Home, 10m)))).Should().BeNull();

        // ... so Alex's split editor, opened before that, would replace Sam's split: refused.
        var stale = await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, loaded, (s.Food, 20m), (s.Fun, 20m)));

        stale.Should().BeOfType<EditConflictException>();
        (await AnswerAsync(stale!)).Should().Be((StatusCodes.Status409Conflict, "Someone else changed this. Reload and try again."));
        (await SlicesAsync(s.Purchase.Id)).Should().BeEquivalentTo(new (Guid?, decimal)[] { (s.Food.Id, 30m), (s.Home.Id, 10m) });

        // Reloaded, Alex's split carries the current version and goes through.
        var current = await LoadVersionAsync<Transaction>(s.Purchase.Id);
        (await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, current, (s.Food, 20m), (s.Fun, 20m)))).Should().BeNull();
        (await SlicesAsync(s.Purchase.Id)).Should().BeEquivalentTo(new (Guid?, decimal)[] { (s.Food.Id, 20m), (s.Fun.Id, 20m) });
    }

    [Fact]
    public async Task A_split_moves_the_transactions_version_so_an_edit_form_loaded_before_it_is_refused()
    {
        // The purchase had no line, so the split writes only the rows under it (slices, jar
        // postings); the row is written back too, so its version moves (#308 review P2-1).
        var s = await SeedPurchaseAsync();
        var loaded = await LoadVersionAsync<Transaction>(s.Purchase.Id);

        (await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, loaded, (s.Food, 30m), (s.Home, 10m)))).Should().BeNull();
        (await LoadVersionAsync<Transaction>(s.Purchase.Id)).Should().NotBe(loaded);

        // The edit form opened before the split would put back its own answers (its "paid from"
        // is written for a split row too): refused.
        var stale = await SaveAsync(db => new UpdateTransactionCommandHandler(db, new CurrentUserStub(s.Owner)).Handle(
            new UpdateTransactionCommand(s.Purchase.Id, s.Purchase.Date, "Supermarket (Alex)", 40m, TransactionType.Expense,
                s.Account.Id, Version: loaded), Ct));

        stale.Should().BeOfType<EditConflictException>();
        await using var verify = fixture.CreateContext();
        (await verify.Transactions.AsNoTracking().SingleAsync(t => t.Id == s.Purchase.Id, Ct)).Payee.Should().Be("Supermarket");
        (await SlicesAsync(s.Purchase.Id)).Should().HaveCount(2);
    }

    [Fact]
    public async Task One_click_writes_under_a_transaction_move_its_version()
    {
        // "Remove split" (an assignment to no line) on a row with no line removes only its slices.
        var s = await SeedPurchaseAsync();
        (await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, null, (s.Food, 30m), (s.Home, 10m)))).Should().BeNull();
        var loaded = await LoadVersionAsync<Transaction>(s.Purchase.Id);

        (await SaveAsync(db => new AssignTransactionCommandHandler(db, new CurrentUserStub(s.Owner)).Handle(
            new AssignTransactionCommand(s.Purchase.Id, null), Ct))).Should().BeNull();

        (await LoadVersionAsync<Transaction>(s.Purchase.Id)).Should().NotBe(loaded);
        (await SaveAsync(db => SplitAsync(db, s.Owner, s.Purchase.Id, loaded, (s.Food, 20m), (s.Fun, 20m))))
            .Should().BeOfType<EditConflictException>("the split editor opened before the split was removed would put it back");
        (await SlicesAsync(s.Purchase.Id)).Should().BeEmpty();

        // Re-sending a confirmed receipt date with a jar division rewrites only the receipt's postings.
        var from = await SeedAccountAsync(s.Owner, "Current");
        var to = await SeedAccountAsync(s.Owner, "Savings", 0m);
        var jar = await SeedAsync(new Jar
        {
            OwnerId = s.Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = to.Id,
        });
        Guid transferId;
        await using (var seed = fixture.CreateContext())
        {
            transferId = (await new CreateTransferCommandHandler(seed, new CurrentUserStub(s.Owner)).Handle(
                new CreateTransferCommand(new DateOnly(2026, 1, 15), 100m, from.Id, to.Id, ReceivedOn: new DateOnly(2026, 1, 16)), Ct)).Id;
        }
        var transferLoaded = await LoadVersionAsync<Transaction>(transferId);

        (await SaveAsync(db => new ConfirmTransferLegsCommandHandler(db, new CurrentUserStub(s.Owner)).Handle(
            new ConfirmTransferLegsCommand(transferId, ReceivedOn: new DateOnly(2026, 1, 16),
                JarAllocations: new[] { new JarAllocationInput(jar.Id, 60m) }), Ct))).Should().BeNull();

        (await LoadVersionAsync<Transaction>(transferId)).Should().NotBe(transferLoaded);
        (await SaveAsync(db => new UpdateTransferCommandHandler(db, new CurrentUserStub(s.Owner)).Handle(
            new UpdateTransferCommand(transferId, from.Id, to.Id, 100m, new DateOnly(2026, 1, 15), new DateOnly(2026, 1, 16),
                Version: transferLoaded), Ct)))
            .Should().BeOfType<EditConflictException>("the transfer form opened before would put back its old division");
    }

    [Fact]
    public async Task A_jar_edit_is_checked_on_the_jar_read_under_its_ledger_lock()
    {
        var owner = NewOwner();
        var account = await SeedAccountAsync(owner, "Savings");
        var jar = await SeedAsync(new Jar
        {
            OwnerId = owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        });
        var loaded = await LoadVersionAsync<Jar>(jar.Id);

        (await SaveAsync(db => new UpdateJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateJarCommand(
            jar.Id, "Summer holiday", JarKind.Goal, 1000m, null, AccrualMethod.TargetByDate, account.Id, Version: loaded), Ct)))
            .Should().BeNull();
        var stale = await SaveAsync(db => new UpdateJarCommandHandler(db, new CurrentUserStub(owner)).Handle(new UpdateJarCommand(
            jar.Id, "Holiday", JarKind.Goal, 1500m, null, AccrualMethod.TargetByDate, account.Id, Version: loaded), Ct));

        stale.Should().BeOfType<EditConflictException>();
        await using var verify = fixture.CreateContext();
        var row = await verify.Jars.AsNoTracking().SingleAsync(j => j.Id == jar.Id, Ct);
        row.Name.Should().Be("Summer holiday");
        row.TargetAmount.Should().Be(1000m);
    }

    [Fact]
    public async Task Account_member_group_and_line_edits_refuse_a_stale_save()
    {
        var owner = NewOwner();
        var account = await SeedAccountAsync(owner, "Everyday");
        var member = await SeedAsync(new HouseholdMember { OwnerId = owner, Name = "Sam", NetMonthlyIncome = 2000m });
        var line = new BudgetItem { Name = "Rent", PlannedAmount = 900m };
        var group = new BudgetCategory { Name = "Home", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { line } };
        await SeedAsync(new BudgetMonth
        {
            OwnerId = owner, Year = 2026, Month = 10, BaseCurrency = CurrencyCode.Eur, Categories = new List<BudgetCategory> { group },
        });
        var user = new CurrentUserStub(owner);

        var accountVersion = await LoadVersionAsync<Account>(account.Id);
        var memberVersion = await LoadVersionAsync<HouseholdMember>(member.Id);
        var groupVersion = await LoadVersionAsync<BudgetCategory>(group.Id);
        var lineVersion = await LoadVersionAsync<BudgetItem>(line.Id);

        (await SaveAsync(db => new UpdateAccountCommandHandler(db, user).Handle(
            new UpdateAccountCommand(account.Id, "Joint", AccountType.Current, 1000m, Jan1, Version: accountVersion), Ct))).Should().BeNull();
        (await SaveAsync(db => new UpdateAccountCommandHandler(db, user).Handle(
            new UpdateAccountCommand(account.Id, "Everyday", AccountType.Current, 1000m, Jan1, Version: accountVersion), Ct)))
            .Should().BeOfType<EditConflictException>();

        (await SaveAsync(db => new UpdateHouseholdMemberCommandHandler(db, user).Handle(
            new UpdateHouseholdMemberCommand(member.Id, "Samantha", 2000m, null, memberVersion), Ct))).Should().BeNull();
        (await SaveAsync(db => new UpdateHouseholdMemberCommandHandler(db, user).Handle(
            new UpdateHouseholdMemberCommand(member.Id, "Sam", 2500m, null, memberVersion), Ct)))
            .Should().BeOfType<EditConflictException>();

        (await SaveAsync(db => new RenameBudgetCategoryCommandHandler(db, user).Handle(
            new RenameBudgetCategoryCommand(group.Id, "House", groupVersion), Ct))).Should().BeNull();
        (await SaveAsync(db => new RenameBudgetCategoryCommandHandler(db, user).Handle(
            new RenameBudgetCategoryCommand(group.Id, "Housing", groupVersion), Ct)))
            .Should().BeOfType<EditConflictException>();

        (await SaveAsync(db => new UpdateBudgetItemCommandHandler(db, user).Handle(
            new UpdateBudgetItemCommand(line.Id, 950m, null, lineVersion), Ct))).Should().BeNull();
        (await SaveAsync(db => new UpdateBudgetItemCommandHandler(db, user).Handle(
            new UpdateBudgetItemCommand(line.Id, 800m, null, lineVersion), Ct)))
            .Should().BeOfType<EditConflictException>();

        await using var verify = fixture.CreateContext();
        (await verify.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id, Ct)).Name.Should().Be("Joint");
        var savedMember = await verify.HouseholdMembers.AsNoTracking().SingleAsync(m => m.Id == member.Id, Ct);
        savedMember.Name.Should().Be("Samantha");
        savedMember.NetMonthlyIncome.Should().Be(2000m);
        (await verify.BudgetCategories.AsNoTracking().SingleAsync(c => c.Id == group.Id, Ct)).Name.Should().Be("House");
        (await verify.BudgetItems.AsNoTracking().SingleAsync(i => i.Id == line.Id, Ct)).PlannedAmount.Should().Be(950m);
    }

    [Fact]
    public async Task Changing_only_a_profiles_rules_moves_its_version()
    {
        var owner = NewOwner();
        var profile = await SeedAsync(new AllocationProfile { OwnerId = owner, Name = "Default" });
        var loaded = await LoadVersionAsync<AllocationProfile>(profile.Id);
        var user = new CurrentUserStub(owner);

        // The first save changes the rules alone; the profile's own row is written back so its
        // version moves, and the second form, which never saw those rules, can't replace them.
        (await SaveAsync(db => new UpsertAllocationProfileCommandHandler(db, user).Handle(new UpsertAllocationProfileCommand(
            profile.Id, "Default", null, new[] { new AllocationRuleSpec(1, AllocationRuleType.FundEnvelopes, SplitMethod.Equal, 0m) },
            25, loaded), Ct))).Should().BeNull();
        var stale = await SaveAsync(db => new UpsertAllocationProfileCommandHandler(db, user).Handle(new UpsertAllocationProfileCommand(
            profile.Id, "Default", null, Array.Empty<AllocationRuleSpec>(), 25, loaded), Ct));

        stale.Should().BeOfType<EditConflictException>();
        await using var verify = fixture.CreateContext();
        (await verify.AllocationRules.AsNoTracking().CountAsync(r => r.AllocationProfileId == profile.Id, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task A_change_committed_between_the_read_and_the_save_is_refused_by_the_update_itself()
    {
        var owner = NewOwner();
        var account = await SeedAccountAsync(owner, "Everyday");

        await using var slow = fixture.CreateContext();
        var tracked = await slow.Accounts.SingleAsync(a => a.Id == account.Id, Ct);
        slow.ExpectVersion(tracked, EditVersions.Of(tracked));
        await using (var fast = fixture.CreateContext())
        {
            (await fast.Accounts.SingleAsync(a => a.Id == account.Id, Ct)).Name = "Joint";
            await fast.SaveChangesAsync(Ct);
        }

        tracked.Name = "Household";
        var thrown = await Record.ExceptionAsync(() => slow.SaveChangesAsync(Ct));

        thrown.Should().BeOfType<DbUpdateConcurrencyException>();
        (await AnswerAsync(thrown!)).Should().Be((StatusCodes.Status409Conflict, "Someone else changed this. Reload and try again."));
        // The ledger-row race (P3-9) keeps its own wording.
        (await AnswerAsync(new DbUpdateConcurrencyException("ledger row")))
            .Should().Be((StatusCodes.Status409Conflict, "Something else changed this at the same moment. Reload and try again."));
        await using var verify = fixture.CreateContext();
        (await verify.Accounts.AsNoTracking().SingleAsync(a => a.Id == account.Id, Ct)).Name.Should().Be("Joint");
    }

    [Fact]
    public async Task A_malformed_version_is_a_bad_request_not_a_conflict()
    {
        // #308 review P3-2: a value no DTO carried (not base64, or not a row version's length) is
        // a 400, so a caller is told its request is wrong rather than to reload.
        var owner = NewOwner();
        var member = await SeedAsync(new HouseholdMember { OwnerId = owner, Name = "Sam" });
        foreach (var malformed in new[] { "not-a-version", Convert.ToBase64String(new byte[12]), Convert.ToBase64String(new byte[4]), "" })
        {
            var refused = await SaveAsync(db => new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub(owner)).Handle(
                new UpdateHouseholdMemberCommand(member.Id, "Sammy", 0m, null, malformed), Ct));
            refused.Should().BeOfType<ValidationException>(malformed);
            (await AnswerAsync(refused!)).Status.Should().Be(StatusCodes.Status400BadRequest);
        }
        await using var verify = fixture.CreateContext();
        (await verify.HouseholdMembers.AsNoTracking().SingleAsync(m => m.Id == member.Id, Ct)).Name.Should().Be("Sam");
    }

    [Fact]
    public async Task A_save_with_no_version_is_not_checked()
    {
        // A client loaded before this deploy sends none: its save is taken as before.
        var owner = NewOwner();
        var member = await SeedAsync(new HouseholdMember { OwnerId = owner, Name = "Sam" });
        await using (var other = fixture.CreateContext())
        {
            (await other.HouseholdMembers.SingleAsync(m => m.Id == member.Id, Ct)).Name = "Samantha";
            await other.SaveChangesAsync(Ct);
        }

        (await SaveAsync(db => new UpdateHouseholdMemberCommandHandler(db, new CurrentUserStub(owner)).Handle(
            new UpdateHouseholdMemberCommand(member.Id, "Sammy", 0m, null), Ct))).Should().BeNull();
        await using var verify = fixture.CreateContext();
        (await verify.HouseholdMembers.AsNoTracking().SingleAsync(m => m.Id == member.Id, Ct)).Name.Should().Be("Sammy");
    }
}
