using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Jars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// His 1 Oct answer "Refuse" (fix plan E): a payment on an archived jar's line may never push the
/// jar below zero. An archived jar holds nothing (rule 26), so a new payment, an assignment or a
/// split onto its line is refused unless the jar holds the draw on that date and every later one;
/// a live jar's payment may still overdraw it (rule 5).
/// </summary>
public class ArchivedJarPaymentTests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static CurrentUserStub User => new(Owner);

    private static (Account Account, Jar Jar, BudgetItem JarLine, BudgetItem Groceries) Seed(ApplicationDbContext db, bool archived = true)
    {
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 500m, Accrual = AccrualMethod.FixedMonthly,
            MonthlyContribution = 50m, FundingAccountId = account.Id, IsArchived = archived, ArchivedOn = archived ? Today : null,
        };
        db.Jars.Add(jar);
        var jarLine = new BudgetItem { Name = "Holiday", SavingsId = jar.Id };
        var groceries = new BudgetItem { Name = "Groceries", PlannedAmount = 200m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = Today.Year, Month = Today.Month, BaseCurrency = CurrencyCode.Eur,
            Categories =
            {
                new BudgetCategory { Name = "Savings", Kind = CategoryKind.Savings, Items = { jarLine } },
                new BudgetCategory { Name = "Household", Kind = CategoryKind.Expense, DisplayOrder = 1, Items = { groceries } },
            },
        });
        db.SaveChanges();
        return (account, jar, jarLine, groceries);
    }

    [Fact]
    public async Task A_new_payment_on_an_archived_jars_line_is_refused()
    {
        await using var db = NewContext();
        var (account, _, jarLine, _) = Seed(db);

        var act = () => new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Hotel", 30m, TransactionType.Expense, jarLine.Id, account.Id), Ct);

        (await act.Should().ThrowAsync<ValidationException>())
            .Which.Errors.Values.SelectMany(v => v).Should().Contain(m => m.Contains("Holiday is archived") && m.Contains("Restore Holiday"));
        (await db.Transactions.CountAsync()).Should().Be(0);
    }

    [Fact]
    public async Task Assigning_or_splitting_onto_an_archived_jars_line_is_refused()
    {
        await using var db = NewContext();
        var (account, _, jarLine, groceries) = Seed(db);
        var payment = LedgerFixtures.Expense(db, Owner, account.Id, 30m, Today, groceries.Id);

        var assign = () => new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(payment.Id, jarLine.Id), Ct);
        await assign.Should().ThrowAsync<ValidationException>();

        var split = () => new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(payment.Id,
            new[] { new SplitAllocationInput(groceries.Id, 10m), new SplitAllocationInput(jarLine.Id, 20m) }), Ct);
        await split.Should().ThrowAsync<ValidationException>();
    }

    [Fact]
    public async Task An_archived_jar_may_pay_what_it_holds_and_a_live_jar_may_still_be_overdrawn()
    {
        await using var db = NewContext();
        var (account, jar, jarLine, _) = Seed(db);
        // 20 came back into the archived jar (a refund's share, say): it can pay 20, not more.
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 20m, Today.AddDays(-1), JarAllocationKind.Reallocation);
        var handler = new CreateTransactionCommandHandler(db, User);
        var tooMuch = () => handler.Handle(new CreateTransactionCommand(Today, "Hotel", 25m, TransactionType.Expense, jarLine.Id, account.Id), Ct);
        await tooMuch.Should().ThrowAsync<ValidationException>();
        await handler.Handle(new CreateTransactionCommand(Today, "Hotel", 20m, TransactionType.Expense, jarLine.Id, account.Id), Ct);

        await using var live = NewContext();
        var (liveAccount, _, liveLine, _) = Seed(live, archived: false);
        await new CreateTransactionCommandHandler(live, User).Handle(
            new CreateTransactionCommand(Today, "Hotel", 30m, TransactionType.Expense, liveLine.Id, liveAccount.Id), Ct);
        (await live.Transactions.CountAsync()).Should().Be(1);
    }

    [Fact]
    public async Task An_imported_row_on_an_archived_jars_line_is_held_counting_earlier_rows_of_the_import()
    {
        // #301 review P2-1: most payments arrive by import, so "Refuse" holds a bank row the
        // archived jar can't cover, with the reason, and imports the rest.
        await using var db = NewContext();
        var (account, jar, jarLine, groceries) = Seed(db);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 40m, Today.AddDays(-1), JarAllocationKind.Reallocation);

        var result = await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(account.Id, new[]
        {
            new CommitImportItem("BANK-1", Today, "Hotel", 30m, "EUR", false, jarLine.Id, null),
            new CommitImportItem("BANK-2", Today, "Ferry", 30m, "EUR", false, jarLine.Id, null),
            new CommitImportItem("BANK-3", Today, "Shop", 30m, "EUR", false, groceries.Id, null),
        }), Ct);

        result.Imported.Should().Be(2);
        result.Held.Should().ContainSingle().Which.Message.Should().Contain("Holiday is archived and holds 10").And.Contain("Restore Holiday");
        db.ChangeTracker.Clear();
        (await JarLedgerReader.LoadAsync(db, Owner, Ct)).At(Today).BalanceOf(jar.Id).Should().Be(10m);
    }
}
