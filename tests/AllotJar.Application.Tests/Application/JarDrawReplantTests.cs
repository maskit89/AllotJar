using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.CreateBudgetMonth;
using AllotJar.Application.Budgets.Commands.SkipJarContribution;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Imports.Commands.CommitImport;
using AllotJar.Application.Jars.Commands.ReallocateJarMoney;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Dtos;
using AllotJar.Application.Jars.Queries.GetJars;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.AssignTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.CreateTransfer;
using AllotJar.Application.Transactions.Commands.DeleteTransaction;
using AllotJar.Application.Transactions.Commands.SplitTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransaction;
using AllotJar.Application.Transactions.Commands.UpdateTransfer;
using AllotJar.Application.Transactions.Dtos;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// Recalculate on every payment (Christopher, 27 Oct 2026): money leaving a Recurring jar
/// replants its current and later months, whether or not the payment is marked paid. His example:
/// a 120 yearly jar due in September holds its 120 when September comes, so the cycle rolls
/// forward Funded and plans 0 toward next September; the bill paid from the jar in September,
/// not marked paid, leaves 0 in it, so September and every month already created plan 10
/// (120 over the twelve months to the next deadline). Handlers read today's UTC date, so the
/// scenarios are built relative to it: "September" is the current month, the deadline its 1st.
/// Rule 83 is unchanged: no payment is ever inferred as the one that closed a cycle.
/// </summary>
public class JarDrawReplantTests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly M0 = new(Today.Year, Today.Month, 1);
    private static readonly DateOnly M1 = M0.AddMonths(1);
    private static readonly DateOnly M2 = M0.AddMonths(2);

    private static CurrentUserStub User => new(Owner);

    private static Task CreateMonthAsync(ApplicationDbContext db, DateOnly month, bool copy = true) =>
        new CreateBudgetMonthCommandHandler(db, User).Handle(new CreateBudgetMonthCommand(month.Year, month.Month, copy), Ct);

    private static Task<IReadOnlyList<JarDto>> ListAsync(ApplicationDbContext db) =>
        new GetJarsQueryHandler(db, User).Handle(new GetJarsQuery(), Ct);

    private static BudgetItem LineFor(ApplicationDbContext db, Guid jarId, DateOnly month) => db.BudgetItems
        .AsNoTracking()
        .Single(i => i.SavingsId == jarId && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month);

    private static decimal PlannedIn(ApplicationDbContext db, Guid jarId, DateOnly month) => LineFor(db, jarId, month).PlannedAmount;

    /// <summary>A 120 yearly jar due on <paramref name="due"/>, holding <paramref name="held"/> since well before.</summary>
    private static Jar SeedYearlyJar(ApplicationDbContext db, Account account, DateOnly due, decimal held = 120m, bool monthOnly = false)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Car tax", Kind = JarKind.Recurring, TargetAmount = 120m,
            TargetDate = due, CycleDeadline = due, MonthOnly = monthOnly, Accrual = AccrualMethod.TargetByDate,
            RecurMonths = 12, FundingAccountId = account.Id,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        if (held > 0m)
        {
            LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, held, M0.AddDays(-60));
        }
        return jar;
    }

    /// <summary>A month written straight to the store with the jar's line at 0, as a month created before its deadline was.</summary>
    private static void SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar)
    {
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { new() { Name = jar.Name, PlannedAmount = 0m, SavingsId = jar.Id } } },
            },
        });
        db.SaveChanges();
    }

    /// <summary>The bill, paid from the jar's line this month and never marked paid.</summary>
    private static Task<TransactionDto> PayBillAsync(ApplicationDbContext db, Account account, Jar jar) =>
        new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Transport Malta", 120m, TransactionType.Expense, LineFor(db, jar.Id, M0).Id,
                AccountId: account.Id), Ct);

    /// <summary>
    /// The jar on its deadline, holding the 120, with this month and next created. Settled: the
    /// cycle has rolled forward Funded (a month was created, or Jars was read, since the deadline).
    /// Not settled: the months were made before the deadline came and nothing has read the jars
    /// since, so the bill is the first thing to meet the arrived deadline.
    /// </summary>
    private static async Task<(Account Account, Jar Jar)> FundedOnItsDeadlineAsync(ApplicationDbContext db, bool settled, bool monthOnly = false)
    {
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M0, monthOnly: monthOnly);
        if (settled)
        {
            await CreateMonthAsync(db, M0, copy: false);
            await CreateMonthAsync(db, M1);
            (await ListAsync(db)).Single().LastCycle!.Outcome.Should().Be("Funded");
        }
        else
        {
            SeedMonth(db, M0, jar);
            SeedMonth(db, M1, jar);
            (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(M0, "nothing has settled the cycle yet");
        }
        PlannedIn(db, jar.Id, M0).Should().Be(0m, "the jar holds next year's 120 already");
        PlannedIn(db, jar.Id, M1).Should().Be(0m);
        return (account, jar);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    [InlineData(false, true)]
    public async Task Christophers_example_the_bill_paid_from_a_funded_yearly_jar_and_not_marked_paid_plans_10_a_month(bool settled, bool monthOnly)
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled, monthOnly);

        await PayBillAsync(db, account, jar);

        PlannedIn(db, jar.Id, M0).Should().Be(10m, "120 over the twelve months to next year's deadline, this one included");
        PlannedIn(db, jar.Id, M1).Should().Be(10m);
        var card = (await ListAsync(db)).Single();
        card.CurrentBalance.Should().Be(0m);
        card.PlannedThisMonth.Should().Be(10m);
        card.Deadline.Should().Be(M0.AddMonths(12));
        // Rule 83: the payment is not linked to the cycle; the user may still mark it paid.
        card.LastCycle!.Outcome.Should().Be("Funded");
        (await db.JarCycles.AsNoTracking().SingleAsync()).PaymentTransactionId.Should().BeNull();
    }

    [Fact]
    public async Task A_month_created_after_the_bill_plans_10_too()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M0);
        await CreateMonthAsync(db, M0, copy: false);
        await PayBillAsync(db, account, jar);

        await CreateMonthAsync(db, M1);
        await CreateMonthAsync(db, M2, copy: false);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
        PlannedIn(db, jar.Id, M1).Should().Be(10m);
        PlannedIn(db, jar.Id, M2).Should().Be(10m);
    }

    [Fact]
    public async Task Deleting_the_bill_puts_the_money_back_and_the_plan_back_to_0()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        var bill = await PayBillAsync(db, account, jar);
        PlannedIn(db, jar.Id, M0).Should().Be(10m);

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(bill.Id), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(0m);
        PlannedIn(db, jar.Id, M1).Should().Be(0m);
    }

    [Fact]
    public async Task Moving_the_bill_off_the_jars_line_or_changing_its_amount_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        var bill = await PayBillAsync(db, account, jar);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(bill.Id, Today, bill.Payee, 60m, TransactionType.Expense, AccountId: account.Id), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(5m, "60 left to save again over twelve months");

        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(bill.Id, null), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(0m, "the payment no longer comes out of the jar");
        PlannedIn(db, jar.Id, M1).Should().Be(0m);

        await new AssignTransactionCommandHandler(db, User).Handle(new AssignTransactionCommand(bill.Id, LineFor(db, jar.Id, M0).Id), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(5m);
    }

    [Fact]
    public async Task A_split_slice_on_the_jars_line_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        var bill = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Transport Malta", 150m, TransactionType.Expense, null, AccountId: account.Id), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(0m);
        var month = await db.BudgetMonths.SingleAsync(m => m.Year == M0.Year && m.Month == M0.Month);
        var fees = new BudgetItem { Name = "Admin fee", PlannedAmount = 30m };
        db.BudgetCategories.Add(new BudgetCategory
        {
            BudgetMonthId = month.Id, Name = "Bills", Kind = CategoryKind.Expense, Items = new List<BudgetItem> { fees },
        });
        await db.SaveChangesAsync(Ct);

        await new SplitTransactionCommandHandler(db, User).Handle(new SplitTransactionCommand(bill.Id, new[]
        {
            new SplitAllocationInput(LineFor(db, jar.Id, M0).Id, 120m),
            new SplitAllocationInput(fees.Id, 30m),
        }), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
    }

    [Fact]
    public async Task Money_moved_out_of_the_jar_by_a_transfer_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Revolut", type: AccountType.Current, order: 1);

        await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Today, 120m, account.Id, other.Id, FromJarId: jar.Id, ReceivedOn: Today), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
    }

    [Fact]
    public async Task Paying_from_the_jar_on_another_line_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Transport Malta", 120m, TransactionType.Expense, null, AccountId: account.Id,
                PaidFromJarId: jar.Id), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
    }

    [Fact]
    public async Task Editing_a_transfer_out_of_the_jar_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Revolut", type: AccountType.Current, order: 1);
        var transfer = await new CreateTransferCommandHandler(db, User).Handle(
            new CreateTransferCommand(Today, 60m, account.Id, other.Id, FromJarId: jar.Id, ReceivedOn: Today), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(5m);

        await new UpdateTransferCommandHandler(db, User).Handle(
            new UpdateTransferCommand(transfer.Id, account.Id, other.Id, 120m, Today, Today, FromJarId: jar.Id), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
        PlannedIn(db, jar.Id, M1).Should().Be(10m);
    }

    [Fact]
    public async Task A_statement_row_on_the_jars_line_replants()
    {
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);

        await new CommitImportCommandHandler(db, User).Handle(new CommitImportCommand(account.Id, new[]
        {
            new CommitImportItem("REF-1", Today, "Transport Malta", 120m, "EUR", IsCredit: false, LineFor(db, jar.Id, M0).Id, null),
        }), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(10m);
        PlannedIn(db, jar.Id, M1).Should().Be(10m);
    }

    [Fact]
    public async Task Moving_the_jars_money_to_another_jar_replants_it()
    {
        // #402 review P2-1: a jar-to-jar move takes the money out as surely as a payment.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M2);
        var other = new Jar
        {
            OwnerId = Owner, Name = "Holiday", Kind = JarKind.Goal, TargetAmount = 600m, TargetDate = M0.AddMonths(6),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(other);
        db.SaveChanges();
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        PlannedIn(db, jar.Id, M0).Should().Be(0m);

        await new ReallocateJarMoneyCommandHandler(db, User).Handle(
            new ReallocateJarMoneyCommand(account.Id, jar.Id, other.Id, 120m, Today), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(60m);
        PlannedIn(db, jar.Id, M1).Should().Be(60m);
    }

    [Fact]
    public async Task Taking_back_money_put_into_the_jar_replants_it()
    {
        // #402 review P2-2: last month's 60 into the jar is deleted, so the jar holds nothing
        // entering this month and the two months to the deadline plan 60 each, not 30.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M2, held: 0m);
        var income = await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(M0.AddDays(-5), "Salary", 60m, TransactionType.Income, null, AccountId: account.Id,
                JarAllocations: new[] { new JarAllocationInput(jar.Id, 60m) }), Ct);
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        PlannedIn(db, jar.Id, M0).Should().Be(30m);

        await new UpdateTransactionCommandHandler(db, User).Handle(
            new UpdateTransactionCommand(income.Id, M0.AddDays(-5), income.Payee, 60m, TransactionType.Income, AccountId: account.Id,
                JarAllocations: new[] { new JarAllocationInput(jar.Id, 20m) }), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(50m, "20 in the jar leaves 100 over two months");

        await new DeleteTransactionCommandHandler(db, User).Handle(new DeleteTransactionCommand(income.Id), Ct);
        PlannedIn(db, jar.Id, M0).Should().Be(60m);
        PlannedIn(db, jar.Id, M1).Should().Be(60m);
    }

    [Fact]
    public async Task A_bill_paid_before_the_deadline_and_not_marked_paid_keeps_the_cycle_open_and_plans_to_refill_it()
    {
        // The jar holds the 120 two months before the deadline; the bill is paid now and never
        // marked. Nothing closes the cycle (rule 83), so the plan is to have 120 again by the
        // deadline: 60 this month and next.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M2);
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        PlannedIn(db, jar.Id, M0).Should().Be(0m);

        await PayBillAsync(db, account, jar);

        PlannedIn(db, jar.Id, M0).Should().Be(60m);
        PlannedIn(db, jar.Id, M1).Should().Be(60m);
        (await db.JarCycles.AnyAsync()).Should().BeFalse();
        (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(M2);
    }

    [Fact]
    public async Task A_bill_paid_before_the_deadline_and_not_marked_paid_still_reads_deadline_missed()
    {
        // Paid "from the jar" the day before the deadline and entered before anything settled the
        // cycle, so the jar was short when the money had to be there: the cycle stays open as
        // Deadline missed (rule 20) until the user marks it paid. The replant's settle judges it
        // so, and so does the next read.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M0);

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(M0.AddDays(-1), "Transport Malta", 120m, TransactionType.Expense, null,
                AccountId: account.Id, PaidFromJarId: jar.Id), Ct);

        (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(M0);
        var card = (await ListAsync(db)).Single();
        card.Status.Should().Be("DeadlineMissed");
        card.LastCycle.Should().BeNull();
        card.Deadline.Should().Be(M0);
        (await db.JarCycles.AnyAsync()).Should().BeFalse();
    }

    [Fact]
    public async Task Money_put_in_settles_nothing_so_a_bill_entered_later_still_reads_deadline_missed()
    {
        // #402 review P2-4: the jar was 20 short; the 20 saved before the deadline is entered
        // first, then the bill paid from the jar the day before the deadline. Putting money in
        // must not roll the cycle forward Funded before the bill is known.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M0, held: 100m);
        SeedMonth(db, M0, jar);

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(M0.AddDays(-3), "Salary", 20m, TransactionType.Income, null, AccountId: account.Id,
                JarAllocations: new[] { new JarAllocationInput(jar.Id, 20m) }), Ct);
        (await db.Jars.AsNoTracking().SingleAsync()).CycleDeadline.Should().Be(M0, "money in settles nothing");
        (await db.JarCycles.AnyAsync()).Should().BeFalse();

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(M0.AddDays(-1), "Transport Malta", 120m, TransactionType.Expense, null,
                AccountId: account.Id, PaidFromJarId: jar.Id), Ct);

        (await ListAsync(db)).Single().Status.Should().Be("DeadlineMissed");
        (await db.JarCycles.AnyAsync()).Should().BeFalse();
    }

    [Fact]
    public async Task A_skipped_month_and_an_amount_typed_by_hand_are_kept()
    {
        // Rule 60 and O3b: next month is skipped and the one after has 25 typed by hand, so the
        // other ten months to the deadline share the 95 left: 9.50 each.
        await using var db = NewContext();
        var (account, jar) = await FundedOnItsDeadlineAsync(db, settled: true);
        await CreateMonthAsync(db, M2);
        await new SkipJarContributionCommandHandler(db, User).Handle(new SkipJarContributionCommand(LineFor(db, jar.Id, M1).Id), Ct);
        await new UpdateBudgetItemCommandHandler(db, User).Handle(new UpdateBudgetItemCommand(LineFor(db, jar.Id, M2).Id, 25m), Ct);

        await PayBillAsync(db, account, jar);

        PlannedIn(db, jar.Id, M0).Should().Be(9.5m);
        LineFor(db, jar.Id, M1).IsSkipped.Should().BeTrue();
        PlannedIn(db, jar.Id, M1).Should().Be(0m);
        PlannedIn(db, jar.Id, M2).Should().Be(25m);
        LineFor(db, jar.Id, M2).IsPlannedByHand.Should().BeTrue();
    }

    [Fact]
    public async Task Money_put_into_the_jar_does_not_replant_rule_14()
    {
        // A 120 jar due in three months with nothing saved plans 40 a month; 50 arriving this
        // month is a contribution, not a reason to lower the plan already written (rule 14).
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var jar = SeedYearlyJar(db, account, M0.AddMonths(3), held: 0m);
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        PlannedIn(db, jar.Id, M1).Should().Be(40m);

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Salary", 50m, TransactionType.Income, null, AccountId: account.Id,
                JarAllocations: new[] { new JarAllocationInput(jar.Id, 50m) }), Ct);

        PlannedIn(db, jar.Id, M0).Should().Be(40m);
        PlannedIn(db, jar.Id, M1).Should().Be(40m);
    }

    [Fact]
    public async Task A_goal_is_not_replanted_by_a_payment()
    {
        // The decision covers Recurring jars; a Goal's plan is unchanged by this PR.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current);
        var goal = new Jar
        {
            OwnerId = Owner, Name = "Sofa", Kind = JarKind.Goal, TargetAmount = 300m, TargetDate = M0.AddMonths(3),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
        };
        db.Jars.Add(goal);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, account.Id, goal.Id, 150m, M0.AddDays(-60));
        await CreateMonthAsync(db, M0, copy: false);
        await CreateMonthAsync(db, M1);
        PlannedIn(db, goal.Id, M1).Should().Be(50m);

        await new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Deposit", 100m, TransactionType.Expense, LineFor(db, goal.Id, M0).Id, AccountId: account.Id), Ct);

        PlannedIn(db, goal.Id, M1).Should().Be(50m);
    }
}
