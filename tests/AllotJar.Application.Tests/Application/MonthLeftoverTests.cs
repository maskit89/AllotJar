using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Accounts;
using AllotJar.Application.Budgets;
using AllotJar.Application.Budgets.Queries.GetMonthWrapUp;
using AllotJar.Application.Jars;
using AllotJar.Application.Reports;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// What a month leaves over for the next one, in actual money (<see cref="MonthLeftover"/>, rule
/// 94): the money in the household's accounts that is neither spent nor in a jar. Each month adds
/// what new accounts held, what came in, what came from private accounts, and takes off what was
/// spent from its own money (a bill a jar paid was saved for earlier) and what went into jars, so
/// carried from month to month it always equals that money, whichever button moved it.
/// </summary>
public class MonthLeftoverTests
{
    private const string Owner = "user-1";
    private static readonly DateOnly September = new(2026, 9, 1);

    private sealed record Lines(Guid Salary, Guid Food, Guid Holiday);

    private static Lines SeedMonth(ApplicationDbContext db, DateOnly month, Jar jar)
    {
        var salary = new BudgetItem { Name = "Salary", PlannedAmount = 3000m };
        var food = new BudgetItem { Name = "Food", PlannedAmount = 2800m };
        var holiday = new BudgetItem { Name = jar.Name, PlannedAmount = 200m, SavingsId = jar.Id };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = month.Year, Month = month.Month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory>
            {
                new() { Name = "Income", Kind = CategoryKind.Income, DisplayOrder = 0, Items = new List<BudgetItem> { salary } },
                new() { Name = "Living", Kind = CategoryKind.Expense, DisplayOrder = 0, Items = new List<BudgetItem> { food } },
                new() { Name = "Savings", Kind = CategoryKind.Savings, DisplayOrder = 0, Items = new List<BudgetItem> { holiday } },
            },
        });
        db.SaveChanges();
        return new Lines(salary.Id, food.Id, holiday.Id);
    }

    private static Jar NewJar(ApplicationDbContext db, Guid accountId, string name = "Holiday")
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 5000m, TargetDate = new DateOnly(2027, 7, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = accountId,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>
    /// Everyday (500) and Savings (1,000) opened on 1 September, 300 of Savings set aside into
    /// Holiday when it was made. September: 3,000 in, 2,500 spent on food, 200 moved into the jar
    /// and a 50 bill paid from it. October: 3,000 in, 3,100 on food and 20 on no line.
    /// </summary>
    private static async Task<ApplicationDbContext> SeedAsync()
    {
        var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", opening: 500m, openingDate: September, type: AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", opening: 1000m, openingDate: September, order: 1);
        var jar = NewJar(db, savings.Id);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 300m, September);

        var sep = SeedMonth(db, September, jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 25), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 2500m, new DateOnly(2026, 9, 12), sep.Food);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 200m, new DateOnly(2026, 9, 26), JarAllocationKind.Reallocation);
        LedgerFixtures.Expense(db, Owner, savings.Id, 50m, new DateOnly(2026, 9, 28), sep.Holiday);

        var oct = SeedMonth(db, September.AddMonths(1), jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 10, 25), oct.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 3100m, new DateOnly(2026, 10, 12), oct.Food);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 20m, new DateOnly(2026, 10, 14));
        return db;
    }

    private static Task<MoneyChain> ChainAsync(ApplicationDbContext db) =>
        MonthLeftover.ReadAsync(db, Owner, CurrencyCode.Eur, CancellationToken.None);

    /// <summary>The household's money with no job on a date: every shared account's balance less every jar's.</summary>
    private static async Task<decimal> NoJobAsync(ApplicationDbContext db, DateOnly asOf)
    {
        var accounts = await db.Accounts.Where(a => !db.AccountPrivacies.Any(p => p.AccountId == a.Id)).ToListAsync();
        var balances = await AccountLedgerReader.ReadAsync(db, Owner, accounts, asOf, CancellationToken.None);
        var jars = await JarLedgerReader.ReadAsync(db, Owner, asOf, CancellationToken.None);
        return balances.Values.Sum(v => v.Balance ?? 0m) - jars.Jars.Keys.Sum(id => jars.BalanceOf(id) ?? 0m);
    }

    private static Transaction Transfer(ApplicationDbContext db, Guid from, Guid to, decimal amount, DateOnly departed, DateOnly? received)
    {
        var transfer = new Transaction
        {
            OwnerId = Owner, AccountId = from, TransferAccountId = to, Amount = amount, Currency = CurrencyCode.Eur,
            Type = TransactionType.Transfer, Date = departed, DepartedOn = departed, ReceivedOn = received, Payee = "Transfer",
        };
        db.Transactions.Add(transfer);
        db.SaveChanges();
        return transfer;
    }

    /// <summary>The stored jar split of one account leg (rule 78): each posting a jar, or unallocated when null.</summary>
    private static void Share(ApplicationDbContext db, Guid accountId, Transaction transaction, DateOnly date, params (Guid? Jar, decimal Amount)[] postings)
    {
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = accountId, Kind = JarAllocationKind.Movement, Date = date, TransactionId = transaction.Id,
            CreatedUtc = DateTime.UtcNow,
            Postings = postings.Select(p => new JarAllocationPosting { JarId = p.Jar, Amount = p.Amount }).ToList(),
        });
        db.SaveChanges();
    }

    [Fact]
    public async Task AMonth_AddsItsNewAccountsAndIncome_LessWhatItSpentAndPutInJars()
    {
        await using var db = await SeedAsync();

        var september = (await ChainAsync(db)).Of(2026, 9);

        september.NewAccounts.Should().Be(1500m, "Everyday and Savings were opened in September");
        september.Received.Should().Be(3000m);
        september.Spent.Should().Be(2500m, "the 50 bill the jar paid was saved for, not spent from September's money");
        september.IntoJars.Should().Be(500m, "the 300 set aside when the jar was made and the 200 moved in");
        september.SetAside.Should().Be(300m);
        september.LeftOver.Should().Be(1500m);
        september.OutsidePlan.Should().Be(1200m, "the new accounts' money, less what the new jar started with");
        (await NoJobAsync(db, new DateOnly(2026, 9, 30))).Should().Be(1500m);
    }

    [Fact]
    public async Task AnOverspentMonth_LeavesLessThanItHad_AndUncategorisedSpendingCounts()
    {
        await using var db = await SeedAsync();

        var october = (await ChainAsync(db)).Of(2026, 10);

        october.Spent.Should().Be(3120m);
        october.IntoJars.Should().Be(0m);
        october.LeftOver.Should().Be(-120m);
    }

    [Fact]
    public async Task WhatEachMonthLeavesAddsUp_ToTheMoneyWithNoJob()
    {
        await using var db = await SeedAsync();

        var chain = await ChainAsync(db);

        chain.CarriedInto(2026, 9).Should().Be(0m, "no money was recorded before September");
        chain.CarriedInto(2026, 10).Should().Be(1500m);
        chain.CarriedInto(2026, 11).Should().Be(1380m, "1,500 into October, which overspent by 120");
        (await NoJobAsync(db, new DateOnly(2026, 10, 31))).Should().Be(1380m);
        // A month with no budget still moves money: December has none, and January carries what it left (nothing).
        chain.CarriedInto(2027, 1).Should().Be(1380m);
    }

    [Fact]
    public async Task TheWrapUp_CountsWhatEarlierMonthsCarriedIn()
    {
        await using var db = await SeedAsync();

        var wrapUp = await new GetMonthWrapUpQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMonthWrapUpQuery(2026, 10), CancellationToken.None);

        wrapUp.CarriedIn.Should().Be(1500m);
        wrapUp.NewAccounts.Should().Be(0m);
        wrapUp.Received.Should().Be(3000m);
        wrapUp.Spent.Should().Be(3120m);
        wrapUp.IntoJars.Should().Be(0m);
        wrapUp.PrivateTransfers.Should().Be(0m);
        wrapUp.LeftOver.Should().Be(1380m);
        wrapUp.ToAllot.Should().Be(1500m, "October's budget gives a job to what September left");
    }

    [Fact]
    public async Task TheFirstMonthsWrapUp_GivesAJobToTheMoneyTheAccountsStartedWith()
    {
        await using var db = await SeedAsync();

        var wrapUp = await new GetMonthWrapUpQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMonthWrapUpQuery(2026, 9), CancellationToken.None);

        wrapUp.CarriedIn.Should().Be(0m);
        wrapUp.ToAllot.Should().Be(1200m, "1,500 in the new accounts, 300 of it in the new jar");
        wrapUp.LeftOver.Should().Be(1500m);
    }

    [Fact]
    public async Task AMonthBeforeAnyMoney_CarriesNothing()
    {
        await using var db = await SeedAsync();

        var august = await new GetMonthWrapUpQueryHandler(db, new CurrentUserStub(Owner))
            .Handle(new GetMonthWrapUpQuery(2026, 8), CancellationToken.None);

        august.CarriedIn.Should().Be(0m);
        august.LeftOver.Should().Be(0m);
    }

    [Fact]
    public async Task AHouseholdWithNothingRecorded_CarriesNothing()
    {
        await using var db = NewContext();

        (await ChainAsync(db)).CarriedInto(2026, 10).Should().Be(0m);
    }

    /// <summary>
    /// Savings the household already had (5,000 in Savings before the first budget), September
    /// balanced (3,000 in, 3,000 spent), and 2,000 of those savings put into a jar on 10 September:
    /// "set aside" when the jar is made or "move money" after, October carries the same 3,000.
    /// </summary>
    [Theory]
    [InlineData(JarAllocationKind.Reallocation)]
    [InlineData(JarAllocationKind.InitialAllocation)]
    public async Task SavingsAlreadyInTheAccounts_CarryTheSame_WhicheverWayTheyGoIntoAJar(JarAllocationKind kind)
    {
        await using var db = NewContext();
        var august = new DateOnly(2026, 8, 1);
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", 0m, august, AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 5000m, august, order: 1);
        var jar = NewJar(db, savings.Id, "Car");
        var sep = SeedMonth(db, September, jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 1), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 20), sep.Food);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 2000m, new DateOnly(2026, 9, 10), kind);

        var chain = await ChainAsync(db);

        chain.CarriedInto(2026, 9).Should().Be(5000m, "the savings were there before the first budget");
        chain.CarriedInto(2026, 10).Should().Be(3000m);
        (await NoJobAsync(db, new DateOnly(2026, 9, 30))).Should().Be(3000m);
        chain.Of(2026, 9).OutsidePlan.Should().Be(kind == JarAllocationKind.InitialAllocation ? -2000m : 0m,
            "a jar starts the month with what was set aside when it was made (SC-P2-1)");
    }

    [Fact]
    public async Task AnAccountAddedLater_BringsItsMoney_AndPuttingItInAJarNetsOut()
    {
        await using var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", 0m, September, AccountType.Current);
        var probe = NewJar(db, everyday.Id, "Probe");
        var sep = SeedMonth(db, September, probe);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 1), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 20), sep.Food);
        var later = LedgerFixtures.SeedAccount(db, Owner, "Later", 1000m, new DateOnly(2026, 9, 15), order: 2);
        var jar = NewJar(db, later.Id, "Car");
        LedgerFixtures.Allocate(db, Owner, later.Id, jar.Id, 1000m, new DateOnly(2026, 9, 16), JarAllocationKind.Reallocation);

        var chain = await ChainAsync(db);

        chain.Of(2026, 9).NewAccounts.Should().Be(1000m);
        chain.CarriedInto(2026, 10).Should().Be(0m);
        (await NoJobAsync(db, new DateOnly(2026, 9, 30))).Should().Be(0m);
    }

    /// <summary>
    /// An account opened on 15 September with 1,000, whose statement from 1 September was imported
    /// too: the rows before the opening date are inside that 1,000 (rule 40), so they count once.
    /// </summary>
    [Fact]
    public async Task RowsBeforeAnAccountOpened_CountOnce()
    {
        await using var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", 1000m, new DateOnly(2026, 9, 15), AccountType.Current);
        var jar = NewJar(db, everyday.Id);
        var sep = SeedMonth(db, September, jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 1), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 2000m, new DateOnly(2026, 9, 10), sep.Food);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 100m, new DateOnly(2026, 9, 20), sep.Food);

        var september = (await ChainAsync(db)).Of(2026, 9);

        september.NewAccounts.Should().Be(0m, "1,000 less the 1,000 its earlier rows left");
        september.Received.Should().Be(3000m);
        september.Spent.Should().Be(2100m);
        september.LeftOver.Should().Be(900m);
        (await NoJobAsync(db, new DateOnly(2026, 9, 30))).Should().Be(900m);
    }

    /// <summary>
    /// 500 of what September left moves to a member's private account; 200 comes back from it
    /// straight into the jar. Both leave or join the household's money.
    /// </summary>
    [Fact]
    public async Task MoneyMovedToOrFromAPrivateAccount_LeavesOrJoinsTheHousehold()
    {
        await using var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", 0m, September, AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 0m, September, order: 1);
        var mine = LedgerFixtures.SeedAccount(db, Owner, "Mine", 0m, September, AccountType.Current, order: 2);
        db.AccountPrivacies.Add(new AccountPrivacy { AccountId = mine.Id, UserId = Owner });
        db.SaveChanges();
        var jar = NewJar(db, savings.Id);
        var sep = SeedMonth(db, September, jar);
        LedgerFixtures.Income(db, Owner, everyday.Id, 3000m, new DateOnly(2026, 9, 1), sep.Salary);
        LedgerFixtures.Expense(db, Owner, everyday.Id, 2500m, new DateOnly(2026, 9, 20), sep.Food);
        Transfer(db, everyday.Id, mine.Id, 500m, new DateOnly(2026, 9, 28), new DateOnly(2026, 9, 28));
        var back = Transfer(db, mine.Id, savings.Id, 200m, new DateOnly(2026, 9, 29), new DateOnly(2026, 9, 29));
        Share(db, savings.Id, back, back.Date, (jar.Id, 200m));

        var chain = await ChainAsync(db);

        var september = chain.Of(2026, 9);
        september.PrivateTransfers.Should().Be(-300m);
        september.IntoJars.Should().Be(200m);
        september.LeftOver.Should().Be(0m);
        chain.CarriedInto(2026, 10).Should().Be(0m);
        (await NoJobAsync(db, new DateOnly(2026, 9, 30))).Should().Be(0m);
    }

    /// <summary>A 120 bill paid from the jar on 31 October and budgeted to November's jar line counts in November, as the budget counts it.</summary>
    [Fact]
    public async Task AJarBillBudgetedToTheNextMonth_CountsThere()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 500m, September, order: 1);
        var jar = NewJar(db, savings.Id);
        LedgerFixtures.Allocate(db, Owner, savings.Id, jar.Id, 500m, September);
        SeedMonth(db, September.AddMonths(1), jar);
        var nov = SeedMonth(db, September.AddMonths(2), jar);
        LedgerFixtures.Expense(db, Owner, savings.Id, 120m, new DateOnly(2026, 10, 31), nov.Holiday);

        var chain = await ChainAsync(db);

        chain.Of(2026, 10).LeftOver.Should().Be(0m);
        chain.Of(2026, 11).Spent.Should().Be(0m, "the jar paid it");
        chain.CarriedInto(2026, 11).Should().Be(0m);
        chain.CarriedInto(2026, 12).Should().Be(0m);
    }

    /// <summary>
    /// Payday on 31 October budgeted to November, 500 of it put straight into the jar as it
    /// arrived: November has both. A move with no row of its own counts on its date instead.
    /// </summary>
    [Fact]
    public async Task APaydayBudgetedToTheNextMonth_CountsThere_WithWhatWentStraightIntoAJar()
    {
        await using var db = NewContext();
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 0m, September, order: 1);
        var jar = NewJar(db, savings.Id);
        SeedMonth(db, September.AddMonths(1), jar);
        var nov = SeedMonth(db, September.AddMonths(2), jar);
        var pay = LedgerFixtures.Income(db, Owner, savings.Id, 3000m, new DateOnly(2026, 10, 31), nov.Salary);
        Share(db, savings.Id, pay, pay.Date, (jar.Id, 500m), (null, 2500m));

        var chain = await ChainAsync(db);

        chain.Of(2026, 10).LeftOver.Should().Be(0m);
        chain.Of(2026, 11).Received.Should().Be(3000m);
        chain.Of(2026, 11).IntoJars.Should().Be(500m);
        chain.CarriedInto(2026, 12).Should().Be(2500m);
        (await NoJobAsync(db, new DateOnly(2026, 11, 30))).Should().Be(2500m);
    }

    /// <summary>
    /// Money on its way between two household accounts at a month end is still the household's:
    /// jar money leaving one jar on 31 October and reaching another on 2 November, and money with
    /// no job leaving Everyday on 31 October for Savings.
    /// </summary>
    [Fact]
    public async Task MoneyInTransitBetweenHouseholdAccounts_CarriesNoPhantom()
    {
        await using var db = NewContext();
        var everyday = LedgerFixtures.SeedAccount(db, Owner, "Everyday", 300m, September, AccountType.Current);
        var savings = LedgerFixtures.SeedAccount(db, Owner, "Savings", 500m, September, order: 1);
        var other = LedgerFixtures.SeedAccount(db, Owner, "Other", 0m, September, order: 2);
        var holiday = NewJar(db, savings.Id);
        var car = NewJar(db, other.Id, "Car");
        LedgerFixtures.Allocate(db, Owner, savings.Id, holiday.Id, 500m, September);
        var jarMoney = Transfer(db, savings.Id, other.Id, 400m, new DateOnly(2026, 10, 31), new DateOnly(2026, 11, 2));
        Share(db, savings.Id, jarMoney, new DateOnly(2026, 10, 31), (holiday.Id, -400m));
        Share(db, other.Id, jarMoney, new DateOnly(2026, 11, 2), (car.Id, 400m));
        Transfer(db, everyday.Id, savings.Id, 300m, new DateOnly(2026, 10, 31), new DateOnly(2026, 11, 2));

        var chain = await ChainAsync(db);

        chain.Of(2026, 10).IntoJars.Should().Be(0m, "the jar money left one jar and is on its way to another");
        chain.CarriedInto(2026, 11).Should().Be(300m, "Everyday's 300 is on its way to Savings");
        chain.CarriedInto(2026, 12).Should().Be(300m);
        (await NoJobAsync(db, new DateOnly(2026, 11, 30))).Should().Be(300m);
    }

    /// <summary>
    /// Received and the budget's spending read exactly as the reports read them (one grouped sum per
    /// kind, not the reports' per-line reads): refunds, split rows, rows on no line, private money on
    /// a household line and private money off it.
    /// </summary>
    [Fact]
    public async Task TheBudgetFigures_MatchTheReports()
    {
        await using var db = await SeedAsync();
        var everyday = db.Accounts.Single(a => a.Name == "Everyday");
        var mine = LedgerFixtures.SeedAccount(db, Owner, "Mine", 0m, September, AccountType.Current, order: 3);
        db.AccountPrivacies.Add(new AccountPrivacy { AccountId = mine.Id, UserId = Owner });
        db.SaveChanges();
        var octLines = db.BudgetMonths.AsNoTracking().Include(m => m.Categories).ThenInclude(c => c.Items)
            .Single(m => m.Year == 2026 && m.Month == 10).Categories.SelectMany(c => c.Items).ToList();
        var octFood = octLines.Single(i => i.Name == "Food").Id;
        var octSalary = octLines.Single(i => i.Name == "Salary").Id;
        var shop = LedgerFixtures.Expense(db, Owner, everyday.Id, 80m, new DateOnly(2026, 10, 3), octFood);
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, AccountId = everyday.Id, BudgetItemId = octFood, RefundOfTransactionId = shop.Id, Amount = 30m,
            Currency = CurrencyCode.Eur, Type = TransactionType.Income, Date = new DateOnly(2026, 10, 9), Payee = "Shop",
        });
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, AccountId = everyday.Id, Amount = 90m, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
            Date = new DateOnly(2026, 10, 18), Payee = "Split",
            Splits = new List<TransactionSplit> { new() { BudgetItemId = octFood, Amount = 60m }, new() { Amount = 30m } },
        });
        LedgerFixtures.Income(db, Owner, everyday.Id, 75m, new DateOnly(2026, 10, 20));
        LedgerFixtures.Income(db, Owner, mine.Id, 400m, new DateOnly(2026, 10, 26), octSalary);
        LedgerFixtures.Expense(db, Owner, mine.Id, 45m, new DateOnly(2026, 10, 27));

        var chain = await ChainAsync(db);
        var ledger = await JarLedgerReader.LoadAsync(db, Owner, CancellationToken.None);

        foreach (var start in new[] { September, September.AddMonths(1) })
        {
            var budget = await db.BudgetMonths.AsNoTracking().Include(m => m.Categories).ThenInclude(c => c.Items)
                .SingleAsync(m => m.Year == start.Year && m.Month == start.Month);
            var report = await ReportFigures.ForMonthAsync(db, Owner, start.Year, start.Month, budget, CancellationToken.None);
            var paidByJars = ledger.SpendingBetween(start, start.AddMonths(1).AddDays(-1)).Postings.Sum(p => p.IsRefund ? -p.Amount : p.Amount);
            var month = chain.Of(start.Year, start.Month);
            month.Received.Should().Be(report.IncomeReceived);
            month.Spent.Should().Be(report.Spent - paidByJars);
        }
        chain.Of(2026, 10).Received.Should().Be(3475m, "salary, the loose 75 and the private 400 on the household's line");
        chain.Of(2026, 10).Spent.Should().Be(3260m, "3,120 + 80 − 30 refunded + the split's 90");
    }
}
