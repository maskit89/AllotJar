using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts.Queries.GetAccounts;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Common.Interfaces;
using AllotJar.Application.Reports.Queries.GetMonthReport;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Application.Transactions.Queries.GetTransactions;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.IntegrationTests;

/// <summary>
/// W13 private accounts on the real relational schema: the read filters translate to SQL (the
/// transaction filter's per-side EXISTS checks and the budget-line exception), the private money
/// stays out of the household report, and the write guard refuses another login's change. The
/// unit suite covers the rules on EF InMemory; this pins the SQL translation.
/// </summary>
[Collection(nameof(SqlServerCollection))]
public class PrivateAccountsSqlTests
{
    private readonly SqlServerFixture _fixture;

    public PrivateAccountsSqlTests(SqlServerFixture fixture) => _fixture = fixture;

    private sealed class Viewer(string owner, string userId) : ICurrentUser
    {
        public string? UserId { get; } = userId;
        public string? OwnerId { get; } = owner;
        public HouseholdRole? Role => HouseholdRole.Owner;
    }

    private static readonly DateOnly June10 = new(2026, 6, 10);

    [Fact]
    public async Task Another_logins_private_account_and_its_off_budget_money_are_not_there()
    {
        var owner = $"user-{Guid.NewGuid():N}";
        var samLogin = $"sam-{Guid.NewGuid():N}";
        Guid lineId, privateTx;
        await using (var db = _fixture.CreateContext())
        {
            var shared = NewAccount(owner, "Joint");
            var mine = NewAccount(owner, "Sam's current");
            db.Accounts.AddRange(shared, mine);
            db.AccountPrivacies.Add(new AccountPrivacy { AccountId = mine.Id, UserId = samLogin });

            var month = new BudgetMonth { OwnerId = owner, Year = 2026, Month = 6 };
            var category = new BudgetCategory { BudgetMonth = month, Name = "Food", Kind = CategoryKind.Expense };
            var line = new BudgetItem { BudgetCategory = category, Name = "Groceries", PlannedAmount = 300m };
            category.Items.Add(line);
            month.Categories.Add(category);
            db.BudgetMonths.Add(month);

            var offBudget = Expense(owner, mine.Id, 40m, null);
            db.Transactions.AddRange(
                offBudget,
                Expense(owner, mine.Id, 60m, line.Id),
                Expense(owner, shared.Id, 25m, null),
                new Transaction
                {
                    OwnerId = owner, Type = TransactionType.Transfer, AccountId = mine.Id, TransferAccountId = shared.Id,
                    Amount = 500m, Currency = CurrencyCode.Eur, Date = June10, DepartedOn = June10, Payee = "To joint",
                });
            await db.SaveChangesAsync();
            lineId = line.Id;
            privateTx = offBudget.Id;
        }

        var chris = new Viewer(owner, owner);
        await using (var db = new ApplicationDbContext(_fixture.Options, chris))
        {
            var accounts = await new GetAccountsQueryHandler(db, chris).Handle(new GetAccountsQuery(June10), CancellationToken.None);
            accounts.Select(a => a.Name).Should().Equal("Joint");

            var rows = await new GetTransactionsQueryHandler(db, chris).Handle(new GetTransactionsQuery(), CancellationToken.None);
            rows.Should().HaveCount(3, "the off-budget private expense is hidden");
            rows.Single(r => r.Type == TransactionType.Transfer).AccountName.Should().Be(TransactionMapping.PrivateAccountName);
            rows.Single(r => r.BudgetItemId == lineId).InPrivateAccount.Should().BeTrue();

            var report = await new GetMonthReportQueryHandler(db, chris).Handle(new GetMonthReportQuery(2026, 6), CancellationToken.None);
            report.SpentUncategorised.Should().Be(25m);
        }

        var sam = new Viewer(owner, samLogin);
        await using (var db = new ApplicationDbContext(_fixture.Options, sam))
        {
            (await new GetTransactionsQueryHandler(db, sam).Handle(new GetTransactionsQuery(), CancellationToken.None))
                .Should().HaveCount(4);
            var report = await new GetMonthReportQueryHandler(db, sam).Handle(new GetMonthReportQuery(2026, 6), CancellationToken.None);
            report.SpentUncategorised.Should().Be(25m, "the holder reads the same household report (P56)");
        }

        // Even with the id in hand, another login cannot write into the private account.
        await using (var db = new ApplicationDbContext(_fixture.Options, chris))
        {
            var stranger = await db.Transactions.IgnoreQueryFilters().SingleAsync(t => t.Id == privateTx);
            stranger.Amount = 1m;
            var act = () => db.SaveChangesAsync();
            await act.Should().ThrowAsync<ForbiddenAccessException>();
        }
    }

    [Fact]
    public async Task Making_an_account_private_waits_for_a_jar_being_put_on_it_and_then_refuses()
    {
        // Rules 33/34 when two logins act at once (P55): Chris puts a jar on Sam's shared savings
        // while Sam makes it private, and each request has passed its own check. A save that puts a
        // jar on an account or makes it private locks the account row, so Sam's save waits for the
        // jar to commit, then sees it and refuses: never a jar on a private account.
        var owner = $"user-{Guid.NewGuid():N}";
        var samLogin = $"sam-{Guid.NewGuid():N}";
        var account = NewAccount(owner, "Sam's savings");
        await using (var seed = _fixture.CreateContext())
        {
            seed.Accounts.Add(account);
            await seed.SaveChangesAsync();
        }

        await using var chris = new ApplicationDbContext(_fixture.Options, new Viewer(owner, owner));
        await using var chrisWrite = await chris.Database.BeginTransactionAsync();
        chris.Jars.Add(new Jar
        {
            OwnerId = owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 1000m,
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        });
        await chris.SaveChangesAsync();

        await using var sam = new ApplicationDbContext(_fixture.Options, new Viewer(owner, samLogin));
        sam.AccountPrivacies.Add(new AccountPrivacy { AccountId = account.Id, UserId = samLogin });
        var samSave = sam.SaveChangesAsync();
        await Task.WhenAny(samSave, Task.Delay(TimeSpan.FromSeconds(1)));
        samSave.IsCompleted.Should().BeFalse("Sam's save waits on the account row Chris's jar holds");

        await chrisWrite.CommitAsync();
        var act = () => samSave;
        (await act.Should().ThrowAsync<ValidationException>()).Which.Errors["IsPrivate"].Single().Should().Contain("Holiday");

        await using var verify = _fixture.CreateContext();
        (await verify.AccountPrivacies.AnyAsync(p => p.AccountId == account.Id)).Should().BeFalse();
        (await verify.Jars.CountAsync(j => j.FundingAccountId == account.Id)).Should().Be(1);
    }

    private static Account NewAccount(string owner, string name) => new()
    {
        OwnerId = owner, Name = name, Type = AccountType.Current, Currency = CurrencyCode.Eur,
        OpeningBalance = 1000m, OpeningDate = new DateOnly(2026, 1, 1),
    };

    private static Transaction Expense(string owner, Guid accountId, decimal amount, Guid? lineId) => new()
    {
        OwnerId = owner, AccountId = accountId, BudgetItemId = lineId, Amount = amount, Currency = CurrencyCode.Eur,
        Type = TransactionType.Expense, Date = June10, Payee = "Shop",
    };
}
