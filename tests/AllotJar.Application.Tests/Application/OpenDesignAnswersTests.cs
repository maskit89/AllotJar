using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Budgets.Commands.SkipJarContribution;
using AllotJar.Application.Budgets.Commands.UpdateBudgetItem;
using AllotJar.Application.Budgets.Queries.GetBudgetMonth;
using AllotJar.Application.Common.Exceptions;
using AllotJar.Application.Jars;
using AllotJar.Application.Jars.Commands.ArchiveJar;
using AllotJar.Application.Jars.Commands.CompleteJar;
using AllotJar.Application.Jars.Commands.MarkJarCyclePaid;
using AllotJar.Application.Jars.Commands.ReopenJar;
using AllotJar.Application.Jars.Commands.UpdateJar;
using AllotJar.Application.Jars.Queries.GetJarSchedule;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Application.Transactions.Commands.CreateTransaction;
using AllotJar.Application.Transactions.Commands.LinkRefund;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The HANDOVER's open design questions as Christopher answered them on 1 October 2026:
/// O3b (a replant keeps an amount typed by hand on a later month), O3c (a completed Goal can be
/// reopened), O9a (a refund in another account nets its purchase's jar line, its money staying
/// where it arrived) and O9b (a refund against a completed Goal or a paid cycle goes back into
/// the jar). O3a and O4 are pinned next to the behaviour they change (JarLifecycleW04Tests,
/// IncomeAllocatorTests, AllocationIncomeFromBudgetTests).
/// </summary>
public class OpenDesignAnswersTests
{
    private const string Owner = "user-1";
    private static readonly CancellationToken Ct = CancellationToken.None;
    private static readonly CurrentUserStub User = new(Owner);

    private static readonly DateOnly Today = DateOnly.FromDateTime(DateTime.UtcNow);
    private static readonly DateOnly Current = new(Today.Year, Today.Month, 1);
    private static readonly DateOnly Next = Current.AddMonths(1);
    private static readonly DateOnly After = Current.AddMonths(2);

    /// <summary>A 300 Goal due on the 1st in three months: 100 a month this month and the next two.</summary>
    private static Jar SeedJar(ApplicationDbContext db, Account account, JarKind kind = JarKind.Goal, decimal target = 300m)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = "Sofa", Kind = kind, TargetAmount = target, TargetDate = Current.AddMonths(3),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id,
            RecurMonths = kind == JarKind.Recurring ? 12 : null,
            CycleDeadline = kind == JarKind.Recurring ? Current.AddMonths(3) : null,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    private static BudgetItem SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar, decimal planned)
    {
        var line = new BudgetItem { Name = jar.Name, PlannedAmount = planned, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, Items = new List<BudgetItem> { new() { Name = "Salary", PlannedAmount = 1000m } } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } },
            },
        });
        db.SaveChanges();
        return line;
    }

    private static Dictionary<DateOnly, BudgetItem> SeedPlan(ApplicationDbContext db, Jar jar) => new()
    {
        [Current] = SeedMonth(db, Current, jar, 100m),
        [Next] = SeedMonth(db, Next, jar, 100m),
        [After] = SeedMonth(db, After, jar, 100m),
    };

    private static BudgetItem LineFor(ApplicationDbContext db, Jar jar, DateOnly month) => db.BudgetItems
        .AsNoTracking()
        .Single(i => i.SavingsId == jar.Id && i.BudgetCategory.BudgetMonth.Year == month.Year && i.BudgetCategory.BudgetMonth.Month == month.Month);

    private static async Task<decimal?> BalanceAsync(ApplicationDbContext db, Jar jar) =>
        (await JarLedgerReader.ReadAsync(db, Owner, Today, Ct)).BalanceOf(jar.Id);

    private static Task<AllotJar.Application.Budgets.Dtos.BudgetMonthDto> TypeAsync(ApplicationDbContext db, BudgetItem line, decimal amount) =>
        new UpdateBudgetItemCommandHandler(db, User).Handle(new UpdateBudgetItemCommand(line.Id, amount), Ct);

    private static UpdateJarCommand Retarget(Jar jar, Account account, decimal target) =>
        new(jar.Id, jar.Name, jar.Kind, target, jar.TargetDate, AccrualMethod.TargetByDate, account.Id);

    private static Task<AllotJar.Application.Transactions.Dtos.TransactionDto> RefundAsync(
        ApplicationDbContext db, Transaction purchase, decimal amount, Guid accountId, Guid? lineId = null) =>
        new CreateTransactionCommandHandler(db, User).Handle(
            new CreateTransactionCommand(Today, "Shop refund", amount, TransactionType.Income, lineId, AccountId: accountId,
                RefundOfTransactionId: purchase.Id), Ct);

    // ---- O3b: a replant keeps an amount typed by hand on a later month -----------------------

    [Fact]
    public async Task O3b_ARetarget_KeepsAnAmountTypedOnALaterMonth_AndTheOtherMonthsCarryTheRest()
    {
        // 300 over three months is 100 each. The user types 150 on the month after next, then
        // raises the target to 600: that month keeps its 150 and this month and next share the
        // 450 left (225 each). The preview before Save says the same, month by month.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, account);
        var lines = SeedPlan(db, jar);

        await TypeAsync(db, lines[After], 150m);
        LineFor(db, jar, After).IsPlannedByHand.Should().BeTrue();

        var preview = await new GetJarScheduleQueryHandler(db, User).Handle(
            new GetJarScheduleQuery(jar.Id, JarKind.Goal, 600m, jar.TargetDate, AccrualMethod.TargetByDate), Ct);
        preview.Months.Select(m => (m.Planned, m.ByHand)).Should().Equal((225m, false), (225m, false), (150m, true));

        await new UpdateJarCommandHandler(db, User).Handle(Retarget(jar, account, 600m), Ct);

        LineFor(db, jar, Current).PlannedAmount.Should().Be(225m);
        LineFor(db, jar, Next).PlannedAmount.Should().Be(225m);
        LineFor(db, jar, After).PlannedAmount.Should().Be(150m);
        LineFor(db, jar, After).IsPlannedByHand.Should().BeTrue();
    }

    [Fact]
    public async Task O3b_AnAmountTypedOnThisMonth_IsReplantedAsBefore_AndSkippingAMonthHandsItBackToTheSchedule()
    {
        // Only later months are protected (P29 still rewrites the current month), and skipping or
        // planning a month again clears the hand-typed mark.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, account);
        var lines = SeedPlan(db, jar);

        await TypeAsync(db, lines[Current], 40m);
        await TypeAsync(db, lines[Next], 60m);
        await new UpdateJarCommandHandler(db, User).Handle(Retarget(jar, account, 600m), Ct);

        // Next keeps 60; this month and the one after share 540.
        LineFor(db, jar, Current).PlannedAmount.Should().Be(270m);
        LineFor(db, jar, Next).PlannedAmount.Should().Be(60m);
        LineFor(db, jar, After).PlannedAmount.Should().Be(270m);

        await new SkipJarContributionCommandHandler(db, User).Handle(new SkipJarContributionCommand(lines[Next].Id), Ct);
        LineFor(db, jar, Next).IsPlannedByHand.Should().BeFalse();
        await new SkipJarContributionCommandHandler(db, User).Handle(new SkipJarContributionCommand(lines[Next].Id, false), Ct);

        LineFor(db, jar, Current).PlannedAmount.Should().Be(200m);
        LineFor(db, jar, Next).PlannedAmount.Should().Be(200m);
        LineFor(db, jar, After).PlannedAmount.Should().Be(200m);
    }

    [Fact]
    public async Task O3b_TypingAnOrdinaryLine_DoesNotMarkIt()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, account);
        SeedMonth(db, Current, jar, 100m);
        var salary = db.BudgetItems.Single(i => i.Name == "Salary");

        await TypeAsync(db, salary, 1200m);

        db.BudgetItems.AsNoTracking().Single(i => i.Id == salary.Id).IsPlannedByHand.Should().BeFalse();
    }

    // ---- O3c: reopening a completed Goal ------------------------------------------------------

    [Fact]
    public async Task O3c_ReopeningACompletedGoal_PlansAgainFromTheMoneyStillInIt()
    {
        // 120 was set aside before this month. Completing stops the plan (P40); reopening makes the
        // Goal active again and replants this month and later ones from the 120: 180 over three
        // months. No money moves.
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, account);
        SeedPlan(db, jar);
        LedgerFixtures.Allocate(db, Owner, account.Id, jar.Id, 120m);
        await new CompleteJarCommandHandler(db, User).Handle(new CompleteJarCommand(jar.Id), Ct);
        db.BudgetItems.Count(i => i.SavingsId == jar.Id).Should().Be(1, "completing removed the later months' lines");

        var reopened = await new ReopenJarCommandHandler(db, User).Handle(new ReopenJarCommand(jar.Id), Ct);

        reopened.CompletedOn.Should().BeNull();
        reopened.Status.Should().NotBe("Completed");
        reopened.CurrentBalance.Should().Be(120m);
        reopened.PlannedThisMonth.Should().Be(60m);
        LineFor(db, jar, Current).PlannedAmount.Should().Be(60m);
        LineFor(db, jar, Next).PlannedAmount.Should().Be(60m);
        LineFor(db, jar, After).PlannedAmount.Should().Be(60m);
        (await BalanceAsync(db, jar)).Should().Be(120m);
    }

    [Fact]
    public async Task O3c_Reopen_IsRefused_ForAJarThatIsNotCompleted_OrIsArchived()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var live = SeedJar(db, account);
        (await FluentActions.Awaiting(() => new ReopenJarCommandHandler(db, User).Handle(new ReopenJarCommand(live.Id), Ct))
                .Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Be("Sofa is not completed, so there is nothing to reopen.");

        var shelved = SeedJar(db, account);
        await new CompleteJarCommandHandler(db, User).Handle(new CompleteJarCommand(shelved.Id), Ct);
        await new ArchiveJarCommandHandler(db, User).Handle(new ArchiveJarCommand(shelved.Id, true), Ct);
        (await FluentActions.Awaiting(() => new ReopenJarCommandHandler(db, User).Handle(new ReopenJarCommand(shelved.Id), Ct))
                .Should().ThrowAsync<ValidationException>())
            .Which.Errors["Id"].Single().Should().Be("Sofa is archived. Restore it first, then reopen it.");
        (await db.Jars.AsNoTracking().SingleAsync(j => j.Id == shelved.Id)).CompletedOn.Should().NotBeNull();
    }

    [Fact]
    public async Task O3c_AnotherHouseholdsJar_IsForbidden()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, account);
        await new CompleteJarCommandHandler(db, User).Handle(new CompleteJarCommand(jar.Id), Ct);

        await FluentActions.Awaiting(() => new ReopenJarCommandHandler(db, new CurrentUserStub("user-2")).Handle(new ReopenJarCommand(jar.Id), Ct))
            .Should().ThrowAsync<ForbiddenAccessException>();
    }

    // ---- O9a: a refund in another account nets the jar's line; its money stays there ---------

    [Fact]
    public async Task O9a_ARefundIntoAnotherAccount_NetsThePurchasesJarLine_AndStaysOutOfTheJar()
    {
        // Sofa holds 200 in Savings and pays 100 for the sofa from Savings (rule 79: Sofa 100).
        // The shop refunds 30 to the Current account: it lands on Sofa's line (the line reads 70
        // spent after 30 refunded, rules 38/39) and stays in Current: Sofa still holds 100.
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner);
        var current = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current, order: 1);
        var jar = SeedJar(db, savings);
        var line = SeedMonth(db, Current, jar, 100m);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m);
        var purchase = LedgerFixtures.Expense(db, Owner, savings.Id, 100m, Today, line.Id);

        var refund = await RefundAsync(db, purchase, 30m, current.Id);

        refund.BudgetItemId.Should().Be(line.Id);
        refund.AccountId.Should().Be(current.Id);
        (await BalanceAsync(db, jar)).Should().Be(100m);
        var month = await new GetBudgetMonthQueryHandler(db, User).Handle(new GetBudgetMonthQuery(Current.Year, Current.Month), Ct);
        var sofa = month.Categories.SelectMany(c => c.Items).Single(i => i.Id == line.Id);
        sofa.ActualAmount.Should().Be(70m);
        sofa.RefundedAmount.Should().Be(30m);

        // P20 holds: the refunds of the purchase can't add up to more than was paid.
        (await FluentActions.Awaiting(() => RefundAsync(db, purchase, 80m, current.Id, line.Id)).Should().ThrowAsync<ValidationException>())
            .Which.Errors["RefundOfTransactionId"].Single().Should().Contain("more than the 100 paid");
    }

    [Fact]
    public async Task O9a_IncomeInAnotherAccount_LinkedAsTheRefund_MovesOntoTheJarLine_AndAnotherJarsLineIsStillRefused()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner);
        var current = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current, order: 1);
        var jar = SeedJar(db, savings);
        var line = SeedMonth(db, Current, jar, 100m);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m);
        var purchase = LedgerFixtures.Expense(db, Owner, savings.Id, 100m, Today, line.Id);
        var money = LedgerFixtures.Income(db, Owner, current.Id, 25m, Today);

        var linked = await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(money.Id, purchase.Id), Ct);

        linked.BudgetItemId.Should().Be(line.Id);
        (await BalanceAsync(db, jar)).Should().Be(100m);

        // A jar line the purchase wasn't budgeted to keeps rule 79's refusal from another account.
        var other = SeedJar(db, savings);
        var otherLine = new BudgetItem { BudgetCategoryId = line.BudgetCategoryId, Name = "Other", SavingsId = other.Id, DisplayOrder = 1 };
        db.BudgetItems.Add(otherLine);
        db.SaveChanges();
        await FluentActions.Awaiting(() => RefundAsync(db, purchase, 10m, current.Id, otherLine.Id))
            .Should().ThrowAsync<ValidationException>();
    }

    // ---- O9b: a refund against a completed Goal or a paid cycle goes back into the jar -------

    [Fact]
    public async Task O9b_ARefundIntoTheJarsAccount_AgainstACompletedGoal_GoesBackIntoTheJar()
    {
        // Sofa held 200, paid 150 and was completed with 50 left to move. A 40 refund reaches
        // Savings: Sofa holds 90 and the card reads 90 left to move. The same refund against a
        // live Goal stays unallocated, as rule 78's dismissed prompt leaves it.
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, savings);
        var line = SeedMonth(db, Current, jar, 100m);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m);
        var purchase = LedgerFixtures.Expense(db, Owner, savings.Id, 150m, Today, line.Id);
        await new CompleteJarCommandHandler(db, User).Handle(new CompleteJarCommand(jar.Id), Ct);

        await RefundAsync(db, purchase, 40m, savings.Id);

        (await BalanceAsync(db, jar)).Should().Be(90m);
        var card = await JarFigures.ReadOneAsync(db, Owner, await db.Jars.AsNoTracking().SingleAsync(j => j.Id == jar.Id), Today, Ct);
        card.Status.Should().Be("Completed");
        card.CurrentBalance.Should().Be(90m);
        var snapshot = await JarLedgerReader.ReadAsync(db, Owner, Today, Ct);
        snapshot.Accounts[savings.Id].AccountBalance.Should().Be(890m);
        snapshot.Accounts[savings.Id].Unallocated.Should().Be(800m);

        var live = SeedJar(db, savings);
        var liveLine = new BudgetItem { BudgetCategoryId = line.BudgetCategoryId, Name = "Live", SavingsId = live.Id, DisplayOrder = 1 };
        db.BudgetItems.Add(liveLine);
        db.SaveChanges();
        LedgerFixtures.Allocate(db, Owner, savings.Id, live.Id, 100m);
        var livePurchase = LedgerFixtures.Expense(db, Owner, savings.Id, 60m, Today, liveLine.Id);
        await RefundAsync(db, livePurchase, 20m, savings.Id);
        (await BalanceAsync(db, live)).Should().Be(40m);
    }

    [Fact]
    public async Task O9b_ARefundIntoAnotherAccount_AgainstACompletedGoal_StaysWhereItArrived()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner);
        var current = LedgerFixtures.SeedAccount(db, Owner, "Current", type: AccountType.Current, order: 1);
        var jar = SeedJar(db, savings);
        var line = SeedMonth(db, Current, jar, 100m);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m);
        var purchase = LedgerFixtures.Expense(db, Owner, savings.Id, 150m, Today, line.Id);
        await new CompleteJarCommandHandler(db, User).Handle(new CompleteJarCommand(jar.Id), Ct);

        await RefundAsync(db, purchase, 40m, current.Id);

        (await BalanceAsync(db, jar)).Should().Be(50m);
    }

    [Fact]
    public async Task O9b_ARefundOfThePaymentACycleWasMarkedPaidWith_GoesBackIntoTheJar_AndTheCycleStaysPaid()
    {
        // Insurance saved 300 and paid 300; the cycle was marked paid with that payment (rule 83).
        // The insurer refunds 50 to Savings: Insurance holds 50 toward the next cycle and the
        // cycle it paid stays paid. Linking an existing receipt does the same.
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner);
        var jar = SeedJar(db, savings, JarKind.Recurring);
        var line = SeedMonth(db, Current, jar, 100m);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 300m);
        var payment = LedgerFixtures.Expense(db, Owner, savings.Id, 300m, Today, line.Id);
        await new MarkJarCyclePaidCommandHandler(db, User).Handle(new MarkJarCyclePaidCommand(jar.Id, jar.CycleDeadline!.Value, payment.Id), Ct);

        await RefundAsync(db, payment, 50m, savings.Id);

        (await BalanceAsync(db, jar)).Should().Be(50m);
        var cycle = await db.JarCycles.AsNoTracking().SingleAsync(c => c.JarId == jar.Id);
        cycle.Outcome.Should().Be(JarCycleOutcome.Paid);
        cycle.PaymentTransactionId.Should().Be(payment.Id);

        var receipt = LedgerFixtures.Income(db, Owner, savings.Id, 20m, Today);
        await new LinkRefundCommandHandler(db, User).Handle(new LinkRefundCommand(receipt.Id, payment.Id), Ct);
        (await BalanceAsync(db, jar)).Should().Be(70m);
    }
}
