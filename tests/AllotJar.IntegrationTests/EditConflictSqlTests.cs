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
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Transactions;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
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
