using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using AllotJar.Application.Reports.Queries.GetJarSpending;
using AllotJar.Application.Tests.TestDoubles;
using AllotJar.Domain.Entities;
using AllotJar.Domain.Enums;
using AllotJar.Domain.ValueObjects;
using AllotJar.Infrastructure.Persistence;

namespace AllotJar.Application.Tests.Application;

/// <summary>
/// The spending-by-jar report (5 October 2026, from the jar notes): what each jar paid out in a
/// year, month by month, read exactly as the ledger reads a draw from the jar (rule 79), net of
/// the refunds that came back (rule 38). A move between jars is not spending: 50 paid for the vet
/// from the Pets jar after 30 was moved in from Food reads as 50 from Pets and nothing from Food.
/// </summary>
public class JarSpendingReportTests
{
    private const string Owner = "user-1";
    private static readonly CurrentUserStub User = new(Owner);

    private static ApplicationDbContext NewContext() =>
        new(new DbContextOptionsBuilder<ApplicationDbContext>().UseInMemoryDatabase($"jar-spending-{Guid.NewGuid()}").Options);

    private static Jar SeedJar(ApplicationDbContext db, Account account, string name, bool archived = false)
    {
        var jar = new Jar
        {
            OwnerId = Owner, Name = name, Kind = JarKind.Goal, TargetAmount = 500m, TargetDate = new DateOnly(2027, 1, 1),
            Accrual = AccrualMethod.TargetByDate, FundingAccountId = account.Id, IsArchived = archived,
            ArchivedOn = archived ? new DateOnly(2026, 12, 31) : null,
        };
        db.Jars.Add(jar);
        db.SaveChanges();
        return jar;
    }

    /// <summary>The jar's Savings line in a month (rule 79: a payment on it draws from the jar).</summary>
    private static BudgetItem SeedJarLine(ApplicationDbContext db, Jar jar, int year, int month)
    {
        var line = new BudgetItem { Name = jar.Name, SavingsId = jar.Id, PlannedAmount = 0m };
        db.BudgetMonths.Add(new BudgetMonth
        {
            OwnerId = Owner, Year = year, Month = month, BaseCurrency = CurrencyCode.Eur,
            Categories = new List<BudgetCategory> { new() { Name = "Savings", Kind = CategoryKind.Savings, Items = new List<BudgetItem> { line } } },
        });
        db.SaveChanges();
        return line;
    }

    private static void MoveBetweenJars(ApplicationDbContext db, Account account, Jar from, Jar to, decimal amount, DateOnly date)
    {
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = account.Id, Kind = JarAllocationKind.Reallocation, Date = date, CreatedUtc = DateTime.UtcNow,
            Postings = new List<JarAllocationPosting> { new() { JarId = from.Id, Amount = -amount }, new() { JarId = to.Id, Amount = amount } },
        });
        db.SaveChanges();
    }

    private static Task<Reports.Dtos.JarSpendingReportDto> Report(ApplicationDbContext db, int year) =>
        new GetJarSpendingQueryHandler(db, User).Handle(new GetJarSpendingQuery(year), CancellationToken.None);

    [Fact]
    public async Task TheVetBill_CountsWhollyAgainstThePetsJar_AndTheMoveFromFoodIsNotSpending()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 1000m, openingDate: new DateOnly(2026, 1, 1));
        var pets = SeedJar(db, account, "Pets");
        var food = SeedJar(db, account, "Food");
        LedgerFixtures.Allocate(db, Owner, account.Id, pets.Id, 20m, new DateOnly(2026, 1, 1));
        LedgerFixtures.Allocate(db, Owner, account.Id, food.Id, 300m, new DateOnly(2026, 1, 1));
        MoveBetweenJars(db, account, food, pets, 30m, new DateOnly(2026, 3, 9));
        var petsLine = SeedJarLine(db, pets, 2026, 3);
        LedgerFixtures.Expense(db, Owner, account.Id, 50m, new DateOnly(2026, 3, 10), petsLine.Id);

        var report = await Report(db, 2026);

        report.Year.Should().Be(2026);
        var petsRow = report.Jars.Single(j => j.JarId == pets.Id);
        petsRow.Months.Should().HaveCount(12);
        petsRow.Months[2].Should().Be(50m);
        petsRow.Total.Should().Be(50m);
        petsRow.Currency.Should().Be("EUR");
        var foodRow = report.Jars.Single(j => j.JarId == food.Id);
        foodRow.Total.Should().Be(0m, "a move between jars is not spending");
        foodRow.Months.Should().AllSatisfy(m => m.Should().Be(0m));
        report.Jars.Select(j => j.Name).Should().Equal("Food", "Pets");
    }

    [Fact]
    public async Task Draws_CountByTheirOwnDate_FromAnyLine_NetOfRefunds_AndOnlyInTheYear()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 2000m, openingDate: new DateOnly(2025, 1, 1));
        var holiday = SeedJar(db, account, "Holiday");
        LedgerFixtures.Allocate(db, Owner, account.Id, holiday.Id, 900m, new DateOnly(2025, 1, 1));
        var line = SeedJarLine(db, holiday, 2026, 6);
        // A whole payment on the line (June), a slice on the line (July), a payment on another
        // line answered "from Holiday" (August), a refund back into the jar (September), and a
        // payment the year before.
        LedgerFixtures.Expense(db, Owner, account.Id, 250m, new DateOnly(2026, 6, 5), line.Id);
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, AccountId = account.Id, Amount = 120m, Currency = CurrencyCode.Eur, Type = TransactionType.Expense,
            Date = new DateOnly(2026, 7, 2), Payee = "Shop",
            Splits = new List<TransactionSplit>
            {
                new() { BudgetItemId = line.Id, Amount = 80m },
                new() { BudgetItemId = null, Amount = 40m },
            },
        });
        db.SaveChanges();
        var answered = LedgerFixtures.Expense(db, Owner, account.Id, 60m, new DateOnly(2026, 8, 20));
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = account.Id, Kind = JarAllocationKind.Movement, TransactionId = answered.Id, Date = answered.Date,
            CreatedUtc = DateTime.UtcNow, Postings = new List<JarAllocationPosting> { new() { JarId = holiday.Id, Amount = -60m } },
        });
        var refund = new Transaction
        {
            OwnerId = Owner, AccountId = account.Id, Amount = 30m, Currency = CurrencyCode.Eur, Type = TransactionType.Income,
            Date = new DateOnly(2026, 9, 1), Payee = "Hotel", RefundOfTransactionId = answered.Id, BudgetItemId = line.Id,
        };
        db.Transactions.Add(refund);
        db.SaveChanges();
        db.JarAllocations.Add(new JarAllocation
        {
            OwnerId = Owner, AccountId = account.Id, Kind = JarAllocationKind.Movement, TransactionId = refund.Id, Date = refund.Date,
            CreatedUtc = DateTime.UtcNow, Postings = new List<JarAllocationPosting> { new() { JarId = holiday.Id, Amount = 30m } },
        });
        db.SaveChanges();
        LedgerFixtures.Expense(db, Owner, account.Id, 500m, new DateOnly(2025, 11, 5), line.Id);

        var report = await Report(db, 2026);

        var row = report.Jars.Single();
        row.Months[5].Should().Be(250m);
        row.Months[6].Should().Be(80m, "only the slice on the jar's line draws from it");
        row.Months[7].Should().Be(60m);
        row.Months[8].Should().Be(-30m, "a refund comes back into the jar in the month received");
        row.Refunds[8].Should().Be(30m);
        row.Total.Should().Be(360m);
        row.TotalRefunds.Should().Be(30m);
        (await Report(db, 2025)).Jars.Single().Total.Should().Be(500m);
    }

    [Fact]
    public async Task ListsEveryLiveJarAtZero_AnArchivedJarOnlyWithAFigure_AndLeavesWaitingRowsOut()
    {
        await using var db = NewContext();
        var account = LedgerFixtures.SeedAccount(db, Owner, opening: 1000m, openingDate: new DateOnly(2026, 1, 1));
        var idle = SeedJar(db, account, "Car");
        var put = SeedJar(db, account, "Old sofa", archived: true);
        var gone = SeedJar(db, account, "Older sofa", archived: true);
        var putLine = SeedJarLine(db, put, 2026, 2);
        LedgerFixtures.Expense(db, Owner, account.Id, 100m, new DateOnly(2026, 2, 14), putLine.Id);
        var idleLine = SeedJarLine(db, idle, 2026, 4);
        // A jar in an account kept in another currency (W08): a row there waits for its amount in
        // the budget currency and counts nowhere until it is entered.
        var abroad = LedgerFixtures.SeedAccount(db, Owner, "Abroad", opening: 500m, openingDate: new DateOnly(2026, 1, 1), currency: "GBP", order: 1);
        var trip = SeedJar(db, abroad, "Trip");
        var tripLine = SeedJarLine(db, trip, 2026, 5);
        db.Transactions.Add(new Transaction
        {
            OwnerId = Owner, AccountId = abroad.Id, BudgetItemId = tripLine.Id, Amount = 45.5m, Currency = CurrencyCode.From("GBP"),
            FxPending = true, Type = TransactionType.Expense, Date = new DateOnly(2026, 5, 3), Payee = "Cab",
        });
        db.SaveChanges();
        LedgerFixtures.Expense(db, "someone-else", account.Id, 999m, new DateOnly(2026, 4, 3), idleLine.Id);

        var report = await Report(db, 2026);

        report.Jars.Select(j => j.Name).Should().Equal("Car", "Trip", "Old sofa");
        report.Jars.Single(j => j.JarId == idle.Id).Total.Should().Be(0m);
        report.Jars.Single(j => j.JarId == trip.Id).Total.Should().Be(0m);
        report.Jars.Single(j => j.JarId == trip.Id).Currency.Should().Be("GBP");
        report.Jars.Single(j => j.JarId == put.Id).IsArchived.Should().BeTrue();
        report.Jars.Single(j => j.JarId == put.Id).Months[1].Should().Be(100m);
        report.Jars.Should().NotContain(j => j.JarId == gone.Id);
        report.WaitingCount.Should().Be(1);
    }
}
